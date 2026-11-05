import { performance } from "node:perf_hooks";
import {
  DemoError,
  ERROR_CODES,
  isDemoError,
  stripErrorCode,
  type ErrorCode,
  type ErrorDetail,
} from "../../shared/errors";
import { SCENE_ACTIONS, type Scene, type SceneAction, type SceneStep } from "../../shared/scene";
import type {
  AppEvent,
  RunMode,
  RunStatus,
  StepRecord,
  StepStatus,
} from "../../shared/types";
import type { PageDriver } from "../core/page-driver";
import type { OverlayPort } from "../core/ports";
import { executeAction, VISUAL_ACTIONS, type ActionResult } from "./actions";
import { sceneEnvValue } from "../scenes/env";
import { hasBoxTarget, hasStepTarget, stepBoolean, stepNumber, stepString, targetSelector } from "./targets";

export type RunnerClock = {
  now(): number;
  sleep?(ms: number): Promise<void>;
};

export type RunnerOptions = {
  driver: PageDriver;
  overlay: OverlayPort;
  clock?: RunnerClock;
  onEvent?: (event: RunnerEvent) => void;
  screenshotDir: string;
  resolveScene?: (sceneId: string) => Promise<Scene>;
  /** Runs after the new scene is bound but before navigation, so the host can swap policy first. */
  onSceneWillInstall?: (scene: Scene) => void;
  /** Throws when a tool-initiated navigation leaves the scene's allowlist. */
  assertNavigationAllowed?: (url: string) => void;
};

export type RunnerSnapshot = {
  sceneId: string | null;
  title: string;
  status: RunStatus;
  mode: RunMode;
  stepIndex: number;
  stepTotal: number;
  steps: StepRecord[];
  startedAt: string | null;
  elapsedMs: number;
  error: ErrorDetail | null;
  warnings: string[];
  vars: Record<string, string>;
};

export type RunnerPausedEvent = {
  type: "run.paused";
  stepIndex: number;
  reloaded?: boolean;
};

export type RunnerEvent = AppEvent | RunnerPausedEvent;

const DEFAULT_STEP_TIMEOUT_MS = 15_000;
/** Give the new page time to paint before a switch hands control back. */
const SCENE_SWITCH_SETTLE_MS = 400;
const MUTATING_ACTIONS = new Set([
  "goto",
  "login",
  "click",
  "fill",
  "press",
  "scroll",
  "scene",
  "set",
  "mask",
  "blackout",
]);

export class Runner {
  private readonly driver: PageDriver;
  private readonly overlay: OverlayPort;
  private readonly clock: RunnerClock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent?: (event: RunnerEvent) => void;
  private readonly screenshotDir: string;
  private readonly resolveScene?: (sceneId: string) => Promise<Scene>;
  private readonly onSceneWillInstall?: (scene: Scene) => void;
  private readonly assertNavigationAllowed?: (url: string) => void;

  private scene: Scene | null = null;
  private records: StepRecord[] = [];
  private vars: Record<string, string> = {};
  private status: RunStatus = "idle";
  private mode: RunMode = "rehearse";
  private cursor = 0;
  private currentIndex = -1;
  private runStartedAtMs: number | null = null;
  private startedAt: string | null = null;
  private error: DemoError | null = null;
  private warnings: string[] = [];
  private busy = false;
  private pauseRequested = false;
  private stopRequested = false;

  constructor(options: RunnerOptions) {
    if (!options.screenshotDir) {
      throw new DemoError("E_SCENE_INVALID", "Runner 需要 screenshotDir");
    }
    this.driver = options.driver;
    this.overlay = options.overlay;
    this.clock = options.clock ?? { now: () => performance.now() };
    this.sleep = options.clock?.sleep?.bind(options.clock) ?? sleep;
    this.onEvent = options.onEvent;
    this.screenshotDir = options.screenshotDir;
    this.resolveScene = options.resolveScene;
    this.onSceneWillInstall = options.onSceneWillInstall;
    this.assertNavigationAllowed = options.assertNavigationAllowed;
  }

  async load(scene: Scene): Promise<void> {
    if (this.busy) throw new DemoError("E_UNSUPPORTED", "运行中不能加载新场景");
    this.validateScene(scene);
    await this.overlay.clear();
    await this.installScene(scene, true, false, false);
  }

  async start(mode: RunMode): Promise<RunnerSnapshot> {
    if (!["rehearse", "live", "record", "headless"].includes(mode)) {
      throw new DemoError("E_UNSUPPORTED", `未知运行模式：${String(mode)}`);
    }
    if (!this.scene) throw new DemoError("E_SCENE_NOT_FOUND", "没有已加载的场景");
    if (this.busy || this.status === "running") {
      throw new DemoError("E_UNSUPPORTED", "运行已经在进行中");
    }
    if (this.status === "failed") {
      throw new DemoError("E_UNSUPPORTED", "运行已失败，请先 reset", { sceneId: this.scene.id });
    }
    if (this.status === "done") {
      throw new DemoError("E_UNSUPPORTED", "运行已完成，请先 reset", { sceneId: this.scene.id });
    }
    if (this.status === "loading" || this.status === "idle") {
      throw new DemoError("E_UNSUPPORTED", "场景尚未就绪");
    }
    this.mode = mode;
    if (this.runStartedAtMs === null) {
      this.runStartedAtMs = this.clock.now();
      this.startedAt = new Date().toISOString();
    }
    await this.runLoop();
    return this.snapshot();
  }

  async next(): Promise<RunnerSnapshot> {
    if (!this.scene) throw new DemoError("E_SCENE_NOT_FOUND", "没有已加载的场景");
    if (this.busy || this.status === "running") {
      throw new DemoError("E_UNSUPPORTED", "当前步骤仍在执行");
    }
    if (this.status === "failed") {
      throw new DemoError("E_UNSUPPORTED", "运行已失败，请先 reset", { sceneId: this.scene.id });
    }
    if (this.status === "idle" || this.status === "loading") {
      throw new DemoError("E_UNSUPPORTED", "场景尚未就绪");
    }
    if (this.status === "done") return this.snapshot();
    await this.runLoop();
    return this.snapshot();
  }

  async prev(): Promise<RunnerSnapshot> {
    if (!this.scene) throw new DemoError("E_SCENE_NOT_FOUND", "没有已加载的场景");
    if (this.busy || this.status === "running") {
      throw new DemoError("E_UNSUPPORTED", "当前步骤仍在执行，不能回退");
    }
    if (this.currentIndex < 0) {
      throw new DemoError("E_UNSUPPORTED", "还没有可回退的步骤");
    }

    const target = Math.max(0, this.currentIndex - 1);
    const mustReload = this.records
      .slice(target, this.currentIndex + 1)
      .some((record) => MUTATING_ACTIONS.has(record.action));

    this.error = null;
    this.warnings = [];
    this.pauseRequested = false;
    this.stopRequested = false;

    if (mustReload) {
      this.resetRecords();
      this.vars = this.scene.vars ? { ...this.scene.vars } : {};
      this.cursor = 0;
      this.currentIndex = -1;
      this.status = "loading";
      this.emit({ type: "scene.loading", sceneId: this.scene.id });
      try {
        const url = await this.navigateScene(this.scene, true);
        this.status = "paused";
        this.emit({ type: "scene.ready", sceneId: this.scene.id, url });
        this.emit({ type: "run.paused", stepIndex: this.snapshot().stepIndex, reloaded: true });
      } catch (error) {
        this.failRun(this.toDemoError(error, this.currentIndex));
        throw this.error;
      }
      return this.snapshot();
    }

    await this.overlay.clear();
    for (let index = target; index < this.records.length; index += 1) {
      this.records[index].status = "pending";
      delete this.records[index].atMs;
      delete this.records[index].durationMs;
      delete this.records[index].detail;
    }
    this.cursor = target;
    this.currentIndex = target - 1;
    this.status = "paused";
    this.emit({ type: "run.paused", stepIndex: this.snapshot().stepIndex, reloaded: false });
    return this.snapshot();
  }

  pause(): RunnerSnapshot {
    if (this.status === "paused") return this.snapshot();
    if (this.status !== "running") {
      throw new DemoError("E_UNSUPPORTED", `当前状态不能暂停：${this.status}`);
    }
    this.pauseRequested = true;
    return this.snapshot();
  }

  async resume(): Promise<RunnerSnapshot> {
    if (this.status !== "paused") {
      throw new DemoError("E_UNSUPPORTED", `只有 paused 状态可以继续，当前为 ${this.status}`);
    }
    if (this.busy) throw new DemoError("E_UNSUPPORTED", "当前步骤仍在执行");
    await this.runLoop();
    return this.snapshot();
  }

  async stop(): Promise<RunnerSnapshot> {
    if (this.busy) {
      this.stopRequested = true;
      return this.snapshot();
    }
    if (!this.scene) return this.snapshot();
    await this.overlay.clear();
    this.pauseRequested = false;
    this.stopRequested = false;
    this.error = null;
    this.status = "ready";
    return this.snapshot();
  }

  async reset(): Promise<RunnerSnapshot> {
    if (!this.scene) throw new DemoError("E_SCENE_NOT_FOUND", "没有已加载的场景");
    if (this.busy) throw new DemoError("E_UNSUPPORTED", "运行中不能 reset");
    await this.overlay.clear();
    await this.installScene(this.scene, true, true);
    return this.snapshot();
  }

  snapshot(): RunnerSnapshot {
    const stepIndex =
      this.records.length === 0
        ? 0
        : this.currentIndex >= 0
          ? this.currentIndex
          : Math.min(this.cursor, this.records.length - 1);
    return {
      sceneId: this.scene?.id ?? null,
      title: this.scene?.title ?? "",
      status: this.status,
      mode: this.mode,
      stepIndex,
      stepTotal: this.records.length,
      steps: this.records.map((record) => ({ ...record })),
      startedAt: this.startedAt,
      elapsedMs:
        this.runStartedAtMs === null ? 0 : Math.max(0, this.clock.now() - this.runStartedAtMs),
      error: this.error ? this.error.toDetail() : null,
      warnings: [...this.warnings],
      vars: { ...this.vars },
    };
  }

  /** Scene currently owning the stage; changes when a `scene` step switches. */
  currentScene(): Scene | null {
    return this.scene;
  }

  private async installScene(
    scene: Scene,
    resetRun: boolean,
    forceReload = false,
    emitSceneEvents = true,
  ): Promise<void> {
    this.scene = scene;
    this.records = scene.steps.map((step, index) => this.newRecord(step, index));
    this.vars = { ...scene.vars };
    this.cursor = 0;
    this.currentIndex = -1;
    this.error = null;
    this.warnings = [];
    this.pauseRequested = false;
    this.stopRequested = false;
    if (resetRun) {
      this.runStartedAtMs = null;
      this.startedAt = null;
    }
    this.status = "loading";
    if (emitSceneEvents) this.emit({ type: "scene.loading", sceneId: scene.id });
    try {
      this.onSceneWillInstall?.(scene);
      const url = await this.navigateScene(scene, forceReload);
      this.status = "ready";
      if (emitSceneEvents) this.emit({ type: "scene.ready", sceneId: scene.id, url });
    } catch (error) {
      this.failRun(this.toDemoError(error, -1));
      throw this.error;
    }
  }

  private async navigateScene(scene: Scene, forceReload: boolean): Promise<string> {
    const url = sceneUrl(scene, this.vars);
    let current: string | null = null;
    try {
      current = await this.driver.url();
    } catch {
      current = null;
    }
    // AppController may have loaded the page before constructing the Runner.
    if (forceReload || current !== url) {
      await this.driver.navigate(url, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS });
    }
    await this.driver.waitForSelector("body", "visible", DEFAULT_STEP_TIMEOUT_MS);
    return url;
  }

  private async runLoop(): Promise<void> {
    if (this.busy) throw new DemoError("E_UNSUPPORTED", "运行已经在进行中");
    this.busy = true;
    this.pauseRequested = false;
    this.stopRequested = false;
    try {
      while (true) {
        if (this.stopRequested) {
          this.status = "ready";
          return;
        }
        if (this.pauseRequested) {
          this.status = "paused";
          this.emit({ type: "run.paused", stepIndex: this.snapshot().stepIndex });
          return;
        }
        if (!this.scene || this.cursor >= this.scene.steps.length) {
          this.status = "done";
          this.emit({ type: "run.completed", stepTotal: this.records.length });
          return;
        }

        const index = this.cursor;
        const step = this.scene.steps[index];
        this.cursor = index + 1;
        this.currentIndex = index;
        this.status = "running";

        if (await this.executeStep(index, step)) {
          if (this.error) throw this.error;
          return;
        }
        if (this.stopRequested) {
          this.status = "ready";
          return;
        }
        if (this.pauseRequested || this.mustPause(step)) {
          this.status = "paused";
          this.emit({ type: "run.paused", stepIndex: this.snapshot().stepIndex });
          return;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async executeStep(index: number, step: SceneStep): Promise<boolean> {
    const record = this.records[index];
    record.status = "running";
    record.atMs = this.relativeNow();
    this.emit({ type: "step.started", index, id: record.id, action: step.action });

    const started = this.clock.now();
    try {
      const timeoutMs = this.stepTimeout(step);
      const outcome = await this.withTimeout(
        this.performAction(index, step, timeoutMs),
        step.action === "assert" ? timeoutMs + 1000 : timeoutMs,
        index,
        step,
      );

      if (outcome.switchedScene) {
        this.validateScene(outcome.switchedScene);
        await this.holdIfNeeded(step);
        record.status = "passed";
        record.durationMs = Math.max(0, this.clock.now() - started);
        record.detail = outcome.detail;
        this.emit({ type: "step.completed", index, id: record.id, durationMs: record.durationMs });
        await this.installScene(outcome.switchedScene, false);
        await this.sleep(SCENE_SWITCH_SETTLE_MS);
        this.pauseRequested = true;
        return false;
      }

      await this.holdIfNeeded(step);
      record.status = "passed";
      record.durationMs = Math.max(0, this.clock.now() - started);
      record.detail = outcome.detail;
      this.emit({ type: "step.completed", index, id: record.id, durationMs: record.durationMs });
      return false;
    } catch (error) {
      const demoError = this.toDemoError(error, index);
      record.durationMs = Math.max(0, this.clock.now() - started);
      record.detail = demoError.message;

      const visual = VISUAL_ACTIONS.has(step.action);
      if (visual && step.optional === true) {
        record.status = "skipped";
        record.detail = `optional visual step skipped: ${demoError.message}`;
        this.emit({ type: "step.completed", index, id: record.id, durationMs: record.durationMs });
        return false;
      }
      if (visual && stepOnError(step) === "warn") {
        record.status = "failed";
        record.detail = `warning: ${demoError.message}`;
        this.warnings.push(`step ${record.id}: ${demoError.message}`);
        this.emit({ type: "step.failed", index, id: record.id, message: record.detail });
        return false;
      }

      record.status = "failed";
      this.failRun(demoError);
      this.emit({ type: "step.failed", index, id: record.id, message: demoError.message });
      return true;
    }
  }

  private performAction(index: number, step: SceneStep, timeoutMs: number): Promise<ActionResult> {
    if (!this.scene) throw new DemoError("E_SCENE_NOT_FOUND", "没有已加载的场景");
    return executeAction({
      driver: this.driver,
      overlay: this.overlay,
      scene: this.scene,
      step,
      index,
      screenshotDir: this.screenshotDir,
      vars: this.vars,
      timeoutMs,
      sleep: this.sleep,
      resolveScene: this.resolveScene,
      assertNavigationAllowed: this.assertNavigationAllowed,
    });
  }

  private async holdIfNeeded(step: SceneStep): Promise<void> {
    const declaredHoldMs = nonNegative(stepNumber(step, "holdMs", "hold_ms") ?? 0, "holdMs");
    const visualSeconds = VISUAL_ACTIONS.has(step.action) ? (stepNumber(step, "seconds") ?? 0) : 0;
    const holdMs = Math.max(declaredHoldMs, nonNegative(visualSeconds * 1000, "seconds"));
    const waitAfterMs = nonNegative(
      stepNumber(step, "waitAfterMs", "wait_after_ms") ?? 0,
      "waitAfterMs",
    );
    if (holdMs > 0) await this.sleep(holdMs);
    if (waitAfterMs > 0) await this.sleep(waitAfterMs);
  }

  private mustPause(step: SceneStep): boolean {
    if (step.action === "wait_for_presenter") return true;
    const advance = step.advance ?? (this.mode === "live" ? "manual" : "auto");
    return advance === "manual";
  }

  private stepTimeout(step: SceneStep): number {
    const value = stepNumber(step, "timeoutMs", "timeout_ms") ?? DEFAULT_STEP_TIMEOUT_MS;
    if (value <= 0 || value > 600_000) {
      throw new DemoError("E_SCENE_INVALID", `步骤超时必须位于 1..600000ms：${value}`);
    }
    return value;
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    index: number,
    step: SceneStep,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new DemoError("E_STEP_TIMEOUT", `步骤 ${step.id} 超过 ${timeoutMs}ms`, {
            sceneId: this.scene?.id,
            stepIndex: index,
          }),
        );
      }, timeoutMs);
      timer.unref();
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private failRun(error: DemoError): void {
    this.error = error;
    this.status = "failed";
    this.emit({ type: "app.error", code: error.code, message: error.message });
  }

  private toDemoError(error: unknown, index: number): DemoError {
    if (isDemoError(error)) {
      if (error.stepIndex === undefined) {
        return new DemoError(error.code, stripErrorCode(error.code, error.message), {
          sceneId: error.sceneId ?? this.scene?.id,
          stepIndex: index,
          url: error.url,
          selector: error.selector,
          screenshotPath: error.screenshotPath,
          details: error.details,
        });
      }
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const candidate = message.match(/^E_[A-Z_]+/)?.[0] as ErrorCode | undefined;
    const code =
      candidate && (ERROR_CODES as readonly string[]).includes(candidate) ? candidate : "E_UNSUPPORTED";
    return new DemoError(code, stripErrorCode(code, message), {
      sceneId: this.scene?.id,
      stepIndex: index,
    });
  }

  private relativeNow(): number {
    if (this.runStartedAtMs === null) return 0;
    return Math.max(0, this.clock.now() - this.runStartedAtMs);
  }

  private newRecord(step: SceneStep, index: number): StepRecord {
    return {
      index,
      id: step.id || `step-${index}`,
      action: step.action,
      note: step.note,
      status: "pending" as StepStatus,
    };
  }

  private resetRecords(): void {
    if (!this.scene) return;
    this.records = this.scene.steps.map((step, index) => this.newRecord(step, index));
  }

  private validateScene(scene: Scene): void {
    const problems: string[] = [];
    if (scene.schemaVersion !== 1) problems.push(`不支持的 schemaVersion：${String(scene.schemaVersion)}`);
    if (!Array.isArray(scene.steps) || scene.steps.length === 0) problems.push("steps 不能为空");

    const steps = Array.isArray(scene.steps) ? scene.steps : [];
    steps.forEach((step, index) => {
      const prefix = `steps[${index}]`;
      if (!SCENE_ACTIONS.includes(step.action as SceneAction)) {
        problems.push(`${prefix}: 未知动作 ${step.action}`);
      }
      const advance = step.advance;
      if (advance !== undefined && advance !== "auto" && advance !== "manual") {
        problems.push(`${prefix}: advance 非法 ${String(advance)}`);
      }
      const onError = stepOnError(step);
      if (onError !== "stop" && onError !== "warn") {
        problems.push(`${prefix}: on_error 非法 ${String(onError)}`);
      }
      const visual = VISUAL_ACTIONS.has(step.action);
      if (step.optional === true && !visual) {
        problems.push(`${prefix}: optional 只允许视觉动作`);
      }
      if (onError === "warn" && !visual) {
        problems.push(`${prefix}: on_error=warn 只允许视觉动作`);
      }
      if (step.action === "wait" && stepNumber(step, "seconds") === undefined) {
        problems.push(`${prefix}: wait 缺少 seconds`);
      }
      if (step.action === "login" && !stepString(step, "accountId", "account_id")) {
        problems.push(`${prefix}: login 缺少 account_id`);
      }
      if (step.action === "wait_for" && !targetSelector(step) && !stepString(step, "text") && !stepString(step, "url")) {
        problems.push(`${prefix}: wait_for 缺少 selector/text/url`);
      }
      if (["click", "fill", "highlight", "spotlight", "mask"].includes(step.action) && !hasStepTarget(step)) {
        problems.push(`${prefix}: ${step.action} 缺少目标`);
      }
      if (step.action === "annotate" && !hasBoxTarget(step)) {
        problems.push(`${prefix}: annotate 缺少 selector/data_demo_id/坐标`);
      }
      if (step.action === "fill" && !stepString(step, "text")) {
        problems.push(`${prefix}: fill 缺少非空 text`);
      }
      if (
        step.action === "fill" &&
        !targetSelector(step) &&
        !hasBoxTarget(step) &&
        !stepString(step, "target_text", "targetText")
      ) {
        problems.push(`${prefix}: fill 需要 selector/data_demo_id/target_text/坐标`);
      }
      if (step.action === "blackout" && stepBoolean(step, "on") === undefined) {
        problems.push(`${prefix}: blackout 缺少 on`);
      }
      const timeoutMs = stepNumber(step, "timeoutMs", "timeout_ms");
      if (timeoutMs !== undefined && (timeoutMs <= 0 || timeoutMs > 600_000)) {
        problems.push(`${prefix}: timeout_ms 必须位于 1..600000`);
      }
    });

    if (problems.length > 0) {
      throw new DemoError("E_SCENE_INVALID", `场景 ${scene.id} 校验失败：${problems.join("；")}`, {
        sceneId: scene.id,
        details: { problems },
      });
    }
  }

  private emit(event: RunnerEvent): void {
    this.onEvent?.(event);
  }
}

function sceneUrl(scene: Scene, vars: Record<string, string>): string {
  if (scene.url) {
    return interpolateUrl(scene.url, vars);
  }
  if (scene.file) {
    const encoded = scene.file
      .replace(/^\/+/, "")
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `demo://scene/${encodeURIComponent(scene.id)}/${encoded}`;
  }
  throw new DemoError("E_SCENE_INVALID", `场景 ${scene.id} 既没有 url 也没有 file`, {
    sceneId: scene.id,
  });
}

function interpolateUrl(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (name.startsWith("env:")) {
      return sceneEnvValue(name.slice(4));
    }
    const sceneValue = vars[name];
    if (sceneValue === undefined) {
      throw new DemoError("E_SCENE_INVALID", `场景变量缺失：${name}`);
    }
    return sceneValue;
  });
}

function stepOnError(step: SceneStep): "stop" | "warn" {
  const value = step.onError ?? step.on_error;
  if (value === undefined) return "stop";
  if (value === "stop" || value === "warn") return value;
  return String(value) as "stop" | "warn";
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 600_000) {
    throw new DemoError("E_SCENE_INVALID", `${field} 必须位于 0..600000：${value}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
