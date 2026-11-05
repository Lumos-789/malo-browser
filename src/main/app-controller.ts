import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { app, screen, type Session } from "electron";
import path from "node:path";
import type { Scene } from "../shared/scene";
import type {
  AppEvent,
  AppSnapshot,
  RunMode,
  StepRecord,
  WindowMode,
} from "../shared/types";
import { DemoError, isDemoError, stripErrorCode, type ErrorCode } from "../shared/errors";
import { loadScene, listScenes, scriptSha256 } from "./scenes";
import { Runner } from "./runner";
import { ElectronOverlay } from "./electron-overlay";
import { ElectronPageDriver } from "./electron-page-driver";
import {
  ScreencastRecorder,
  buildEvidence,
  writeEvidence,
  type ScreencastCaptureSummary,
} from "./capture";
import { decidePermission, isAllowedNavigation, type SecurityPolicy } from "./security";
import { buildStagePlan, diffStagePlan, recordSceneVisit, type StagePlan } from "./stage-layout";
import { recordingPath } from "./store/paths";
import type { DirectorSnapshot } from "../preload/director-api";
import { registerDemoProtocol } from "./demo-protocol";
import { StageWindow } from "./windows/stage-window";

export type SceneSummary = {
  id: string;
  title: string;
  path: string;
  invalid?: boolean;
  errors?: string[];
  stepTotal?: number;
  profile?: string;
  description?: string;
};

export type ControllerOptions = {
  scenesRoot: string;
  outputRoot: string;
  windowMode: WindowMode;
};

const DENY_ALL_POLICY: SecurityPolicy = {
  allow: [],
  permissions: [],
  downloadsAllowed: false,
  demoOrigin: "demo://scene/none",
};

function initialSnapshot(): AppSnapshot {
  return {
    schemaVersion: 1,
    app: { version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome },
    stage: {
      sceneId: null,
      title: "",
      url: "",
      visible: false,
      blackout: false,
      fullscreen: false,
      displayId: null,
      viewport: { width: 0, height: 0, dpr: 1 },
    },
    run: { mode: "rehearse", status: "idle", stepIndex: 0, stepTotal: 0, steps: [], startedAt: null, elapsedMs: 0 },
    recorder: { status: "idle", outputPath: null, frames: 0, elapsedMs: 0 },
    error: null,
  };
}

export class AppController {
  private readonly emitter = new EventEmitter();
  private snap: AppSnapshot = initialSnapshot();
  private scenes: SceneSummary[] = [];
  private scene: Scene | null = null;
  private stage: StageWindow | null = null;
  private driver: ElectronPageDriver | null = null;
  private overlay: ElectronOverlay | null = null;
  private runner: Runner | null = null;
  private recorder: ScreencastRecorder | null = null;
  private runStartedMs: number | null = null;
  private takeSteps: StepRecord[] = [];
  /** Policy consulted by the long-lived permission/download/navigation handlers. */
  private currentPolicy: SecurityPolicy = DENY_ALL_POLICY;
  private currentStagePlan: StagePlan | null = null;
  /** Set when a navigation was refused, so the aborted loadURL can be explained. */
  private blockedNavigation: { url: string; reason: string } | null = null;
  private readonly wiredSessions = new WeakSet<Session>();
  private recordingScene: Scene | null = null;
  private runSceneIds: string[] = [];
  private recordingStartedAtMs: number | null = null;
  private pendingStageSync: Promise<void> | null = null;

  constructor(private readonly options: ControllerOptions) {}

  async init(): Promise<void> {
    this.scenes = (await listScenes(this.options.scenesRoot)) as SceneSummary[];
    for (const entry of this.scenes) {
      if (entry.invalid) continue;
      try {
        const scene = await loadScene(this.options.scenesRoot, entry.id);
        entry.stepTotal = scene.steps.length;
        entry.profile = scene.profile;
        entry.description = scene.description;
      } catch (error) {
        entry.invalid = true;
        entry.errors = [...(entry.errors ?? []), (error as Error).message];
      }
    }
  }

  listScenes(): SceneSummary[] {
    return this.scenes;
  }

  snapshot(): AppSnapshot {
    return structuredClone(this.snap);
  }

  directorSnapshot(): DirectorSnapshot {
    return {
      ...this.snapshot(),
      displays: screen.getAllDisplays().map((display) => ({
        id: display.id,
        label: display.label || `Display ${display.id}`,
        width: display.size.width,
        height: display.size.height,
        scaleFactor: display.scaleFactor,
        primary: display.id === screen.getPrimaryDisplay().id,
      })),
      scenes: this.scenes.map((entry) => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        stepTotal: entry.stepTotal ?? 0,
        profile: entry.profile,
      })),
    };
  }

  onEvent(listener: (event: AppEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  private emit(event: AppEvent): void {
    this.emitter.emit("event", event);
  }

  private publish(): void {
    this.emit({ type: "state.changed", snapshot: this.snapshot() });
  }

  async loadScene(sceneId: string): Promise<void> {
    const debug = (message: string) => {
      if (process.env.DEMO_DEBUG) console.error(`[malo-browser] ${message}`);
    };
    const scene = await loadScene(this.options.scenesRoot, sceneId);
    debug(`scene loaded ${scene.id} steps=${scene.steps.length}`);
    this.emit({ type: "scene.loading", sceneId });
    this.snap.stage.sceneId = scene.id;
    this.snap.stage.title = scene.title;
    this.snap.run.status = "loading";
    this.publish();

    this.teardownStage();
    const plan = buildStagePlan(scene);
    const stage = new StageWindow({
      width: plan.width,
      height: plan.height,
      showMode: this.options.windowMode,
    });
    // Track the stage before the first await so a failed load cannot leak a
    // window and runner events fired during load can see a live stage.
    this.stage = stage;
    this.currentPolicy = plan.policy;
    this.currentStagePlan = plan;
    this.wireStageSession(stage);
    const webContents = stage.view.webContents;
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    webContents.on("will-navigate", (event, target) => this.gateNavigation(event, target));
    // Server-side 3xx does not emit will-navigate; without this the allowlist
    // could be escaped by a redirect from an allowed origin.
    webContents.on("will-redirect", (event, target) => this.gateNavigation(event, target));
    webContents.on("did-navigate", (_event, target) => {
      if (this.stage !== stage) return;
      this.blockedNavigation = null;
      this.snap.stage.url = target;
      this.publish();
    });
    const driver = new ElectronPageDriver(webContents);
    this.driver = driver;
    const url = plan.url;
    this.blockedNavigation = null;
    try {
      debug(`navigating ${url}`);
      await driver.navigate(url);
      debug("navigated");
      await driver.attach();
      debug("cdp attached");
      await driver.waitForSelector("body", "attached", 15000).catch(() => undefined);

      const overlay = new ElectronOverlay(driver);
      this.overlay = overlay;
      await overlay.inject();
      debug("overlay injected");

      const runner = new Runner({
        driver,
        overlay,
        screenshotDir: path.join(this.options.outputRoot, "errors", scene.id),
        resolveScene: (nextSceneId: string) => loadScene(this.options.scenesRoot, nextSceneId),
        // Policy must flip before the new page starts navigating, otherwise a
        // redirect on load would be judged against the previous scene's allowlist.
        onSceneWillInstall: (next) => {
          this.currentPolicy = buildStagePlan(next).policy;
        },
        assertNavigationAllowed: (target) => this.assertNavigationAllowed(target),
        onEvent: (event: AppEvent) => {
          this.syncFromRunner();
          // Steps of earlier scenes disappear from the runner snapshot on switch;
          // keep them so evidence reflects everything the take actually executed.
          if (
            (event.type === "step.completed" || event.type === "step.failed") &&
            this.runner
          ) {
            const record = this.runner.snapshot().steps[event.index];
            if (record) this.takeSteps.push({ ...record, index: this.takeSteps.length });
          }
          this.emit(event);
          // Runner events arrive synchronously; stage re-layout must not block them.
          if (event.type === "scene.ready") this.scheduleStageSync(event.sceneId, event.url);
        },
      });
      this.runner = runner;
      this.scene = scene;
      // Awaited: start() must not race a still-loading runner ("场景尚未就绪").
      await runner.load(scene);

      const viewport = await driver.evaluate<{ width: number; height: number; dpr: number }>(
        "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
      );
      this.snap.stage.url = url;
      this.snap.stage.visible = this.options.windowMode !== "hidden";
      this.snap.stage.viewport = viewport;
      this.snap.stage.blackout = false;
      this.snap.run.status = "ready";
      this.snap.run.stepTotal = scene.steps.length;
      this.snap.run.stepIndex = 0;
      this.snap.run.steps = runner.snapshot().steps as StepRecord[];
      this.snap.error = null;
      this.emit({ type: "scene.ready", sceneId: scene.id, url });
      this.publish();
    } catch (error) {
      const blocked = this.blockedNavigation as { url: string; reason: string } | null;
      this.snap.stage.sceneId = null;
      this.snap.stage.title = "";
      this.snap.stage.url = "";
      this.snap.run = {
        ...this.snap.run,
        status: "failed",
        steps: [],
        stepTotal: 0,
        stepIndex: 0,
      };
      this.teardownStage();
      // A refused navigation aborts loadURL (ERR_ABORTED / ERR_FAILED depending
      // on where it was stopped); report the policy reason, not an internal error.
      if (blocked !== null && !isDemoError(error)) {
        throw new DemoError("E_NAV_BLOCKED", `导航被拦截：${blocked.url}（${blocked.reason}）`, {
          url: blocked.url,
          sceneId: scene.id,
        });
      }
      throw error;
    }
  }

  private gateNavigation(event: { preventDefault(): void }, target: string): void {
    const verdict = isAllowedNavigation(target, this.currentPolicy.allow);
    if (process.env.DEMO_DEBUG) {
      console.error(
        `[malo-browser] navigation ${target} allowed=${verdict.allowed} (${verdict.reason})`,
      );
    }
    if (verdict.allowed) return;
    event.preventDefault();
    this.blockedNavigation = { url: target, reason: verdict.reason };
    this.reportError(
      new DemoError("E_NAV_BLOCKED", `导航被拦截：${target}（${verdict.reason}）`),
    );
  }

  private assertNavigationAllowed(target: string): void {
    const verdict = isAllowedNavigation(target, this.currentPolicy.allow);
    if (verdict.allowed) return;
    throw new DemoError("E_NAV_BLOCKED", `导航被拦截：${target}（${verdict.reason}）`, {
      url: target,
    });
  }

  /**
   * Permission and download handlers live for the whole session, so they must
   * read the active scene's policy at call time instead of closing over one.
   */
  private wireStageSession(stage: StageWindow): void {
    const session = stage.view.webContents.session;
    registerDemoProtocol(session, this.options.scenesRoot);
    if (this.wiredSessions.has(session)) return;
    this.wiredSessions.add(session);
    session.setPermissionRequestHandler((_contents, permission, callback) => {
      const verdict = decidePermission(permission, this.currentPolicy.permissions);
      if (process.env.DEMO_DEBUG) {
        console.error(`[malo-browser] permission ${permission} allowed=${verdict.allowed} (${verdict.reason})`);
      }
      callback(verdict.allowed);
    });
    session.on("will-download", (event) => {
      if (!this.currentPolicy.downloadsAllowed) event.preventDefault();
    });
  }

  private scheduleStageSync(sceneId: string, url: string): void {
    const run = this.handleStageSync(sceneId, url);
    this.pendingStageSync = run;
    void run.finally(() => {
      if (this.pendingStageSync === run) this.pendingStageSync = null;
    });
  }

  private async handleStageSync(sceneId: string, url: string): Promise<void> {
    try {
      await this.applySceneSwitch(sceneId, url);
    } catch (error) {
      this.reportError(error, "E_STAGE_LAYOUT");
    }
  }

  /**
   * Single place that turns a thrown error into visible state. Every entry
   * point (IPC, shortcuts, control API) must use it so a rejection never
   * escapes to the process-level unhandledRejection handler.
   */
  reportError(error: unknown, fallbackCode: ErrorCode = "E_UNSUPPORTED"): void {
    const code = isDemoError(error) ? error.code : fallbackCode;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = stripErrorCode(code, rawMessage);
    this.snap.error = {
      code,
      message,
      stepIndex: (isDemoError(error) ? error.stepIndex : null) ?? null,
      screenshotPath: (isDemoError(error) ? error.screenshotPath : null) ?? null,
    };
    this.emit({ type: "app.error", code, message });
    this.publish();
  }

  /**
   * A `scene` step keeps the same StageWindow and WebContentsView so the
   * screencast never breaks; only size, policy and scene metadata change.
   */
  private async applySceneSwitch(sceneId: string, url: string): Promise<void> {
    const stage = this.stage;
    const runner = this.runner;
    if (!stage) throw new DemoError("E_STAGE_LAYOUT", `场景切换时 Stage 已被销毁：${sceneId}`);
    if (!runner) throw new DemoError("E_STAGE_LAYOUT", `场景切换时 Runner 不可用：${sceneId}`);

    const scene = runner.currentScene();
    if (!scene || scene.id !== sceneId) {
      throw new DemoError(
        "E_STAGE_LAYOUT",
        `Runner 当前场景与事件不一致：event=${sceneId} runner=${scene?.id ?? "none"}`,
      );
    }
    const plan = buildStagePlan(scene);
    const diff = diffStagePlan(this.currentStagePlan, plan);
    // Fullscreen owns the frame size; the next windowed layout restores the scene size.
    if (diff.resized && !this.snap.stage.fullscreen) stage.resize(plan.width, plan.height);
    this.currentPolicy = plan.policy;
    this.currentStagePlan = plan;
    this.scene = scene;

    this.snap.stage.sceneId = scene.id;
    this.snap.stage.title = scene.title;
    this.snap.stage.url = url;
    if (!this.overlay) throw new DemoError("E_STAGE_LAYOUT", `场景切换时 overlay 不可用：${sceneId}`);
    // A `scene` step can point at the same URL, in which case the page is never
    // reloaded and the black overlay would otherwise survive the switch.
    if (this.snap.stage.blackout) {
      await this.overlay.blackout(false);
    }
    this.snap.stage.blackout = false;
    await this.overlay.inject();
    await this.syncViewport();
    if (this.recorder) this.runSceneIds = recordSceneVisit(this.runSceneIds, scene.id);

    this.emit({
      type: "stage.layout",
      fullscreen: this.snap.stage.fullscreen,
      displayId: this.snap.stage.displayId,
      viewport: { ...this.snap.stage.viewport },
    });
    this.publish();
  }

  private syncFromRunner(): void {
    if (!this.runner) return;
    const state = this.runner.snapshot();
    this.snap.run.status = state.status as AppSnapshot["run"]["status"];
    this.snap.run.stepIndex = state.stepIndex;
    this.snap.run.stepTotal = state.stepTotal;
    this.snap.run.steps = state.steps as StepRecord[];
    this.snap.error = state.error
      ? {
          code: state.error.code,
          message: state.error.message,
          stepIndex: state.error.stepIndex ?? null,
          screenshotPath: state.error.screenshotPath ?? null,
        }
      : null;
  }

  private requireRunner(): Runner {
    if (!this.runner) throw new DemoError("E_SCENE_NOT_FOUND", "还没有加载场景");
    return this.runner;
  }

  async start(mode: RunMode): Promise<void> {
    const runner = this.requireRunner();
    this.runStartedMs = Date.now();
    this.snap.run.mode = mode;
    this.snap.run.startedAt = new Date().toISOString();
    await runner.start(mode);
    this.syncFromRunner();
    if (this.runStartedMs) this.snap.run.elapsedMs = Date.now() - this.runStartedMs;
    this.publish();
  }

  async next(): Promise<void> {
    await this.requireRunner().next();
    this.syncFromRunner();
    this.publish();
  }

  async prev(): Promise<void> {
    await this.requireRunner().prev();
    this.syncFromRunner();
    this.publish();
  }

  pause(): void {
    this.requireRunner().pause();
    this.syncFromRunner();
    this.publish();
  }

  async resume(): Promise<void> {
    await this.requireRunner().resume();
    this.syncFromRunner();
    this.publish();
  }

  async reset(): Promise<void> {
    await this.requireRunner().reset();
    await this.overlay?.clear();
    this.snap.stage.blackout = false;
    this.syncFromRunner();
    this.publish();
  }

  async blackout(on: boolean): Promise<void> {
    if (!this.overlay) throw new DemoError("E_SCENE_NOT_FOUND", "还没有加载场景");
    await this.overlay.blackout(on);
    this.snap.stage.blackout = on;
    this.publish();
  }

  async setFullscreen(on: boolean): Promise<void> {
    if (!this.stage) throw new DemoError("E_SCENE_NOT_FOUND", "还没有加载场景");
    if (this.options.windowMode === "hidden" || this.options.windowMode === "offscreen") {
      throw new DemoError(
        "E_STAGE_LAYOUT",
        `窗口模式 ${this.options.windowMode} 没有全屏语义；现场演示请用 --window-mode=inactive 或 focused 启动`,
      );
    }
    this.stage.setFullscreen(on);
    await waitForStageState(this.stage, on ? "enter-full-screen" : "leave-full-screen", 3000);
    this.snap.stage.fullscreen = on;
    // Fullscreen skips the scene resize; restoring windowed mode must re-apply
    // the active scene's declared viewport instead of the pre-fullscreen one.
    if (!on && this.currentStagePlan) {
      this.stage.resize(this.currentStagePlan.width, this.currentStagePlan.height);
    }
    await this.syncViewport();
    this.emit({
      type: "stage.layout",
      fullscreen: on,
      displayId: this.snap.stage.displayId,
      viewport: { ...this.snap.stage.viewport },
    });
    this.publish();
  }

  async moveToDisplay(displayId: number | null): Promise<void> {
    if (!this.stage) throw new DemoError("E_SCENE_NOT_FOUND", "还没有加载场景");
    if (displayId !== null) this.stage.moveToDisplay(displayId);
    this.snap.stage.displayId = displayId;
    await this.syncViewport();
    this.emit({
      type: "stage.layout",
      fullscreen: this.snap.stage.fullscreen,
      displayId,
      viewport: { ...this.snap.stage.viewport },
    });
    this.publish();
  }

  private async syncViewport(): Promise<void> {
    const driver = this.driver;
    if (!driver) throw new DemoError("E_STAGE_LAYOUT", "Stage 没有可用的页面驱动，无法读取视口");
    const viewport = await driver.evaluate<{ width: number; height: number; dpr: number }>(
      "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })",
    );
    const valid =
      viewport !== null &&
      typeof viewport === "object" &&
      Number.isFinite(viewport.width) &&
      viewport.width > 0 &&
      Number.isFinite(viewport.height) &&
      viewport.height > 0 &&
      Number.isFinite(viewport.dpr) &&
      viewport.dpr > 0;
    if (!valid) {
      throw new DemoError(
        "E_STAGE_LAYOUT",
        `Stage 视口无效：${JSON.stringify(viewport)}`,
      );
    }
    this.snap.stage.viewport = {
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      dpr: viewport.dpr,
    };
  }

  async recordStart(output?: string): Promise<void> {
    if (!this.stage || !this.scene) throw new DemoError("E_SCENE_NOT_FOUND", "还没有加载场景");
    // The stage/scene are bound before the first await, so a slow load would
    // otherwise let a recording start on a half-initialised page.
    if (this.snap.run.status === "loading") {
      throw new DemoError("E_UNSUPPORTED", "场景仍在加载，加载完成后再开始录制");
    }
    const target = output ?? recordingPath(this.options.outputRoot, this.scene.id, new Date());
    const recorder = new ScreencastRecorder({
      webContents: this.stage.view.webContents.debugger,
      outDir: path.dirname(target),
      output: target,
    });
    await recorder.start({ output: target });
    this.recorder = recorder;
    this.recordingScene = this.scene;
    this.recordingStartedAtMs = Date.now();
    this.takeSteps = [];
    this.runSceneIds = recordSceneVisit([], this.scene.id);
    this.snap.recorder = { status: "recording", outputPath: target, frames: 0, elapsedMs: 0 };
    this.emit({ type: "recorder.started", outputPath: target });
    this.publish();
  }

  async recordStop(): Promise<void> {
    if (!this.recorder || !this.recordingScene) {
      throw new DemoError("E_RECORDER_NO_FRAMES", "当前没有进行中的录制");
    }
    const scene = this.recordingScene;
    const recorder = this.recorder;
    const outputPath = this.snap.recorder.outputPath;
    const recordingStartedAtMs = this.recordingStartedAtMs;
    const sceneIds = this.runSceneIds.length > 0 ? [...this.runSceneIds] : [scene.id];
    // Own the take before the first await: a concurrent stop then hits the guard
    // above instead of writing a second evidence file for the same take.
    this.recorder = null;
    this.recordingScene = null;
    this.recordingStartedAtMs = null;
    this.runSceneIds = [];
    // A scene switch finishing late must not overwrite the final viewport in evidence.
    if (this.pendingStageSync) await this.pendingStageSync;
    // Capture steps after the sync so late step events still land in evidence.
    const takeSteps = this.takeSteps;
    this.takeSteps = [];

    let summary: ScreencastCaptureSummary;
    try {
      summary = await recorder.stop();
    } catch (error) {
      const elapsedMs = Math.max(0, Date.now() - (recordingStartedAtMs ?? Date.now()));
      const code = isDemoError(error) ? error.code : "E_RECORDER_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      // A failed take still leaves evidence: "failure also has evidence" must
      // hold for app mode too, not just for --mode=record.
      try {
        await this.writeFailedTakeEvidence({
          scene,
          outputPath,
          sceneIds,
          steps: takeSteps.length > 0 ? takeSteps : this.snap.run.steps,
          recordingStartedAtMs,
          elapsedMs,
          error,
        });
      } catch (evidenceError) {
        console.error(
          `[malo-browser] 失败证据写入失败（${outputPath ?? "无输出路径"}）：${
            (evidenceError as Error).message
          }`,
        );
      }
      this.snap.recorder = { status: "failed", outputPath, frames: 0, elapsedMs };
      this.emit({ type: "app.error", code, message });
      this.publish();
      throw error;
    }
    const elapsedMs = Math.round(summary.durationS * 1000);
    // Describe the take's own window: `run.startedAt` is when the run started,
    // which can be minutes before recording began.
    const startedAt =
      recordingStartedAtMs !== null
        ? new Date(recordingStartedAtMs).toISOString()
        : (this.snap.run.startedAt ?? new Date(Date.now() - elapsedMs).toISOString());
    const endedAt = new Date(Date.parse(startedAt) + elapsedMs).toISOString();
    // Checks may only consider steps executed inside this take; borrowing the
    // whole scene's step list would report steps that are not in the video.
    const checkSteps = takeSteps;
    const recordedSteps = takeSteps.length > 0 ? takeSteps : this.snap.run.steps;
    const stepsMs = checkSteps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
    const evidencePath = summary.file.replace(/\.mp4$/i, ".evidence.json");
    const runError = this.snap.error;
    const evidence = buildEvidence({
      scene,
      app: {
        name: "malo-browser",
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
      },
      status: runError ? "failed" : undefined,
      error: runError
        ? {
            code: runError.code,
            message: runError.message,
            stepIndex: runError.stepIndex,
            screenshotPath: runError.screenshotPath ?? undefined,
          }
        : undefined,
      run: {
        mode: this.snap.run.mode,
        startedAt,
        endedAt,
        elapsedMs,
        windowMode: this.options.windowMode,
        headless: this.options.windowMode === "hidden",
        focusEmulation: true,
        sceneIds,
      },
      capture: {
        viewport: { width: this.snap.stage.viewport.width, height: this.snap.stage.viewport.height },
        deviceScaleFactor: this.snap.stage.viewport.dpr,
        rawFrames: summary.rawFrames,
        effectiveFps: summary.rawFrames / Math.max(0.001, summary.durationS),
        timelineFrames: summary.timelineFrames,
        ackErrors: summary.ackErrors,
        windowVisible: this.snap.stage.visible,
        headless: this.options.windowMode === "hidden",
      },
      steps: recordedSteps.map((step) => ({
        index: step.index,
        id: step.id,
        action: step.action,
        note: step.note,
        atMs: step.atMs,
        durationMs: step.durationMs,
        status: step.status,
        detail: step.detail,
      })),
      checks: {
        frames_arrived: { passed: summary.rawFrames > 0, detail: `raw_frames=${summary.rawFrames}` },
        steps_completed: {
          passed: checkSteps.some((step) => step.status === "passed" || step.status === "failed"),
          detail: `steps=${checkSteps.length} executed=${
            checkSteps.filter((step) => step.status !== "pending").length
          }`,
        },
        steps_within_take: {
          passed:
            checkSteps.length > 0 &&
            summary.durationS + 0.5 >= stepsMs / 1000 &&
            summary.durationS <= stepsMs / 1000 + Math.max(5, (stepsMs / 1000) * 0.5),
          detail: `video=${summary.durationS.toFixed(2)}s steps=${(stepsMs / 1000).toFixed(2)}s`,
        },
      },
      video: summary,
      warnings:
        takeSteps.length === 0 && recordedSteps.length > 0
          ? [
              "no step ran inside this take: the listed steps come from an earlier run and are not covered by the video",
            ]
          : undefined,
    });
    try {
      await writeEvidence(evidencePath, evidence);
    } catch (error) {
      // The encoder already produced the file; without this the snapshot would
      // stay "recording" and every retry would answer E_RECORDER_NO_FRAMES.
      this.snap.recorder = { status: "failed", outputPath: summary.file, frames: summary.frames, elapsedMs };
      this.publish();
      throw error;
    }
    this.snap.recorder = {
      status: "idle",
      outputPath: summary.file,
      frames: summary.frames,
      elapsedMs: Math.round(summary.durationS * 1000),
    };
    this.emit({ type: "recorder.stopped", outputPath: summary.file, frames: summary.frames });
    this.publish();
    const failedChecks = evidence.checks.filter((check) => !check.passed).map((check) => check.id);
    if (failedChecks.length > 0) {
      throw new DemoError("E_EVIDENCE_MISMATCH", `录制自检未通过：${evidencePath}`, {
        sceneId: scene.id,
        details: { evidence: evidencePath, failed_checks: failedChecks },
      });
    }
  }

  currentSceneSha(): string | null {
    return this.scene ? scriptSha256(this.scene) : null;
  }

  /**
   * `recordStop` failures include the zero-frame case (`E_RECORDER_NO_FRAMES`)
   * and encoding/self-check failures. Every entry point must leave evidence, so
   * a failed take writes the same document shape with `video: null` and the
   * real error code instead of only logging a line.
   */
  private async writeFailedTakeEvidence(input: {
    scene: Scene;
    outputPath: string | null;
    sceneIds: string[];
    steps: StepRecord[];
    recordingStartedAtMs: number | null;
    elapsedMs: number;
    error: unknown;
  }): Promise<void> {
    if (!input.outputPath) {
      console.error("[malo-browser] 录制失败但没有输出路径，跳过失败证据");
      return;
    }
    const code = isDemoError(input.error) ? input.error.code : "E_RECORDER_FAILED";
    const rawMessage = input.error instanceof Error ? input.error.message : String(input.error);
    const startedAt =
      this.snap.run.startedAt ??
      new Date(input.recordingStartedAtMs ?? Date.now()).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + input.elapsedMs).toISOString();
    const viewport = this.snap.stage.viewport;
    const viewportValid = viewport.width > 0 && viewport.height > 0 && viewport.dpr > 0;
    const captureViewport = viewportValid
      ? { width: viewport.width, height: viewport.height, dpr: viewport.dpr }
      : {
          width: input.scene.viewport.width,
          height: input.scene.viewport.height,
          dpr: input.scene.viewport.deviceScaleFactor ?? 1,
        };
    const videoExists = await fileExists(input.outputPath);
    const warnings = [
      videoExists
        ? `take failed after encoding: ${input.outputPath} exists on disk but failed self-checks; it is not a valid take`
        : "take failed before encoding: no video was written, this file records the failure",
    ];
    if (!viewportValid) {
      warnings.push("stage viewport was unavailable; evidence falls back to the scene viewport");
    }
    const evidencePath = input.outputPath.replace(/\.mp4$/i, ".evidence.json");
    const evidence = buildEvidence({
      scene: input.scene,
      app: {
        name: "malo-browser",
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
      },
      status: "failed",
      error: {
        code,
        message: stripErrorCode(code, rawMessage),
        stepIndex: this.snap.error?.stepIndex ?? null,
      },
      run: {
        mode: this.snap.run.mode,
        startedAt,
        endedAt,
        elapsedMs: input.elapsedMs,
        windowMode: this.options.windowMode,
        headless: this.options.windowMode === "hidden",
        focusEmulation: true,
        sceneIds: input.sceneIds,
      },
      capture: {
        viewport: { width: captureViewport.width, height: captureViewport.height },
        deviceScaleFactor: captureViewport.dpr,
        rawFrames: 0,
        effectiveFps: 0,
        timelineFrames: 0,
        ackErrors: 0,
        windowVisible: this.snap.stage.visible,
        headless: this.options.windowMode === "hidden",
      },
      steps: input.steps.map((step) => ({
        index: step.index,
        id: step.id,
        action: step.action,
        note: step.note,
        atMs: step.atMs,
        durationMs: step.durationMs,
        status: step.status,
        detail: step.detail,
      })),
      checks: {
        frames_arrived: { passed: false, detail: "raw_frames=0" },
        steps_completed: {
          passed: input.steps.some((step) => step.status === "passed" || step.status === "failed"),
          detail: `steps=${input.steps.length} executed=${
            input.steps.filter((step) => step.status !== "pending").length
          }`,
        },
        steps_within_take: {
          passed: false,
          detail: "duration unknown: the take failed before encoding",
        },
      },
      video: null,
      warnings,
    });
    await writeEvidence(evidencePath, evidence);
  }

  private teardownStage(): void {
    this.runner = null;
    this.overlay = null;
    // Teardown also runs from failure paths: a destroyed webContents throws on
    // detach/close and would mask the original error, so each step is guarded.
    try {
      this.driver?.detach();
    } catch (error) {
      console.error(`[malo-browser] 分离 CDP 失败：${(error as Error).message}`);
    }
    this.driver = null;
    try {
      this.stage?.close();
    } catch (error) {
      console.error(`[malo-browser] 关闭 Stage 失败：${(error as Error).message}`);
    }
    this.stage = null;
    this.scene = null;
    this.currentPolicy = DENY_ALL_POLICY;
    this.currentStagePlan = null;
  }

  dispose(): void {
    this.teardownStage();
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

function waitForStageState(
  stage: StageWindow,
  event: "enter-full-screen" | "leave-full-screen",
  timeoutMs: number,
): Promise<void> {
  const wantFullscreen = event === "enter-full-screen";
  // BaseWindow emits these macOS events at runtime but the typings only expose
  // them on BrowserWindow, so narrow to the two members used here.
  const window = stage.window as unknown as {
    isDestroyed(): boolean;
    isFullScreen(): boolean;
    once(name: string, listener: () => void): void;
    off(name: string, listener: () => void): void;
  };
  if (window.isDestroyed()) return Promise.resolve();
  if (window.isFullScreen() === wantFullscreen) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.off(event, handler);
      reject(new DemoError("E_STAGE_LAYOUT", `Stage 全屏状态在 ${timeoutMs}ms 内未切换到 ${wantFullscreen}`));
    }, timeoutMs);
    const handler = (): void => {
      clearTimeout(timer);
      resolve();
    };
    window.once(event, handler);
  });
}
