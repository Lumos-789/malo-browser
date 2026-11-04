import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { errorCodeFor, stripErrorCode } from "../shared/errors";
import type { Options } from "./cli";
import { CdpPage } from "./cdp-page";
import { sha256File, sha256Text, writeJsonAtomic } from "./evidence";
import { injectOverlay, overlayClick, overlayHighlight, overlayMove } from "./overlay";
import { ScreencastRecorder } from "./recorder";
import { createStage, type ShowMode, type Stage } from "./stage-window";
import { explainLoadFailure, formatOverwriteWarning, sleep } from "./tools";
import { blackReport, encodeFrames, extractFrame, probeVideo } from "./video";

type StepRecord = {
  index: number;
  id: string;
  action: string;
  at_ms: number;
  duration_ms: number;
  status: "passed" | "failed";
  detail?: string;
};

const FPS = 30;
const SCENARIO_ID = "fixture-report-review";

const SCENARIO = [
  { action: "wait_for", selector: "[data-demo-state='ready']" },
  { action: "move", selector: "[data-demo-id='increment']" },
  { action: "click", selector: "[data-demo-id='increment']", expect: "review-count=1" },
  { action: "fill", selector: "[data-demo-id='search']", text: "风险" },
  { action: "assert", detail: "row-3 visible, row-1 filtered out" },
  { action: "highlight", selector: "[data-demo-id='row-3']", seconds: 1.5 },
];

async function countBluePixels(file: string): Promise<number> {
  const png = PNG.sync.read(await readFile(file));
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    if (b > 150 && b - r > 60 && b - g > 40) count += 1;
  }
  return count;
}

async function runScenario(
  page: CdpPage,
  opts: Options,
  t0: number,
  steps: StepRecord[],
): Promise<{ highlightAtMs: number }> {
  let highlightAtMs = 0;

  const run = async (id: string, action: string, fn: () => Promise<string | undefined>) => {
    const at = Date.now() - t0;
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ index: steps.length, id, action, at_ms: at, duration_ms: Date.now() - started, status: "passed", detail });
      console.error(`[malo-browser] 步骤 ${steps.length} ${id} (${action}) ✓ ${Date.now() - started}ms`);
    } catch (error) {
      steps.push({
        index: steps.length,
        id,
        action,
        at_ms: at,
        duration_ms: Date.now() - started,
        status: "failed",
        detail: (error as Error).message,
      });
      console.error(`[malo-browser] 步骤 ${steps.length} ${id} (${action}) ✗ ${(error as Error).message}`);
      throw error;
    }
  };

  await run("ready", "wait_for", async () => {
    await page.waitFor("[data-demo-state='ready']", 15000);
    return "data-demo-state=ready";
  });

  if (opts.plain) {
    await run("hold", "wait", async () => {
      const remaining = opts.seconds * 1000 - (Date.now() - t0);
      if (remaining > 0) await sleep(remaining);
      return `hold ${Math.round((Date.now() - t0) / 100) / 10}s`;
    });
    return { highlightAtMs };
  }

  await run("cursor-to-button", "move", async () => {
    const rect = await page.rect("[data-demo-id='increment']");
    await overlayMove(page, rect.x, rect.y);
    await sleep(250);
    return `point(${Math.round(rect.x)},${Math.round(rect.y)})`;
  });

  await run("mark-reviewed", "click", async () => {
    const rect = await page.rect("[data-demo-id='increment']");
    await overlayClick(page, rect.x, rect.y);
    await page.click(rect.x, rect.y);
    await sleep(280);
    const count = await page.evaluate<string>(
      "document.querySelector('[data-demo-id=\"review-count\"]').textContent.trim()",
    );
    if (count !== "1") {
      const diag = await page.evaluate<{ hit: string | null; active: string | null; dpr: number }>(
        `(() => {
          const el = document.elementFromPoint(${rect.x}, ${rect.y});
          return {
            hit: el ? el.tagName + "[" + (el.getAttribute("data-demo-id") || "") + "]" : null,
            active: document.activeElement ? document.activeElement.tagName : null,
            dpr: window.devicePixelRatio,
          };
        })()`,
      );
      throw new Error(
        `E_ASSERTION_FAILED: review-count 应为 1，实际 ${count}；point(${rect.x.toFixed(1)},${rect.y.toFixed(1)}) hit=${diag.hit} active=${diag.active} dpr=${diag.dpr}`,
      );
    }
    return "review-count=1";
  });

  await run("search-risk", "fill", async () => {
    const rect = await page.rect("[data-demo-id='search']");
    await overlayMove(page, rect.x, rect.y);
    await sleep(150);
    await page.click(rect.x, rect.y);
    await sleep(120);
    await page.selectAll();
    await page.insertText("风险");
    await sleep(280);
    const value = await page.evaluate<string>("document.querySelector('[data-demo-id=\"search\"]').value");
    if (value !== "风险") throw new Error(`E_ASSERTION_FAILED: 搜索框应为「风险」，实际「${value}」`);
    return `value=${value}`;
  });

  await run("rows-filtered", "assert", async () => {
    const state = await page.evaluate<{ risk: boolean; first: boolean }>(
      "({ risk: !!document.querySelector('[data-demo-id=\"row-3\"]'), first: !!document.querySelector('[data-demo-id=\"row-1\"]') })",
    );
    if (!state.risk || state.first) {
      throw new Error(`E_ASSERTION_FAILED: 期望只剩风险行，实际 ${JSON.stringify(state)}`);
    }
    return "row-1 hidden, row-3 visible";
  });

  await run("highlight-risk", "highlight", async () => {
    const rect = await page.rect("[data-demo-id='row-3']");
    highlightAtMs = Date.now() - t0;
    await overlayHighlight(page, rect, 1800);
    await sleep(600);
    return `rect(${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)})`;
  });

  await run("hold", "wait", async () => {
    const remaining = opts.seconds * 1000 - (Date.now() - t0);
    if (remaining > 0) await sleep(remaining);
    return `hold ${Math.round((Date.now() - t0) / 100) / 10}s`;
  });

  return { highlightAtMs };
}

async function openStage(opts: Options) {
  const showMode: ShowMode = opts.windowMode;
  if (process.env.DEMO_DEBUG) console.error("[malo-browser] opening stage");
  const stage = createStage({ width: opts.width, height: opts.height, showMode });
  const page = new CdpPage(stage.view.webContents);
  try {
    if (process.env.DEMO_DEBUG) console.error("[malo-browser] loading url");
    try {
      await stage.view.webContents.loadURL(opts.url);
    } catch (error) {
      throw explainLoadFailure(opts.url, error);
    }
    if (process.env.DEMO_DEBUG) console.error("[malo-browser] url loaded, attaching cdp");
    await page.attach({ focusEmulation: opts.focusEmulation });
    if (process.env.DEMO_DEBUG) console.error("[malo-browser] cdp attached");
    await page.waitFor("[data-demo-state='ready']", 20000);
    if (process.env.DEMO_DEBUG) console.error("[malo-browser] fixture ready");
    const viewport = await page.viewport();
    const nodeExposed = await page.nodeExposed();
    if (!opts.plain) {
      await injectOverlay(page);
    }
    await sleep(700);
    return { stage, page, viewport, nodeExposed, showMode };
  } catch (error) {
    page.detach();
    stage.close();
    throw error;
  }
}

type FailureContext = {
  outDir: string;
  label: string;
  opts: Options;
  startedAtIso: string;
  showMode: ShowMode;
  viewport: { width: number; height: number; dpr: number } | null;
  stageVisible: boolean;
  steps: StepRecord[];
  phase: string;
  error: unknown;
  preexisting: Set<string>;
};

function partialArtifacts(outDir: string, label: string, preexisting: Set<string>): string[] {
  const candidates = [
    `${label}.mp4`,
    `${label}.overlay-frame.png`,
    `${label}.overlay-before.png`,
    `${label}-frames`,
    `${label}-seq`,
  ].map((name) => path.join(outDir, name));
  return candidates
    .filter((file) => existsSync(file) && !preexisting.has(file))
    .map((file) => path.relative(outDir, file));
}

async function writeFailedRecordingEvidence(input: FailureContext): Promise<string> {
  const failedStep = [...input.steps].reverse().find((step) => step.status === "failed");
  const code = errorCodeFor(input.error);
  const rawMessage = input.error instanceof Error ? input.error.message : String(input.error);
  const evidencePath = path.join(input.outDir, `${input.label}.evidence.json`);
  await writeJsonAtomic(evidencePath, {
    schema_version: 1,
    kind: "demo-stage-recording",
    status: "failed",
    app: {
      name: "malo-browser",
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
    },
    scene: {
      id: SCENARIO_ID,
      title: "信审复核台 fixture",
      url: input.opts.url,
      profile: "malo-browser-spike",
      script_sha256: sha256Text(JSON.stringify(SCENARIO)),
    },
    run: {
      mode: input.opts.mode,
      started_at: input.startedAtIso,
      ended_at: new Date().toISOString(),
      elapsed_ms: Date.now() - Date.parse(input.startedAtIso),
      window_mode: input.showMode,
      headless: input.showMode === "hidden",
      focus_emulation: input.opts.focusEmulation,
    },
    ...(input.viewport
      ? {
          capture: {
            method: "electron-cdp-screencast",
            format: "jpeg",
            quality: 90,
            viewport: [input.viewport.width, input.viewport.height],
            device_scale_factor: input.viewport.dpr,
            window_visible: input.stageVisible,
            raw_frames: 0,
          },
        }
      : {}),
    video: null,
    error: {
      code,
      message: stripErrorCode(code, rawMessage),
      step: failedStep?.id ?? input.phase,
      step_index: failedStep?.index ?? null,
    },
    steps: input.steps,
    artifacts: partialArtifacts(input.outDir, input.label, input.preexisting),
    warnings: ["run failed before encoding: no video was written, this file records the failure"],
  });
  return evidencePath;
}

export async function runPhase0(opts: Options): Promise<number> {
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  const startedAtIso = new Date().toISOString();
  const videoPath = path.join(outDir, `${opts.label}.mp4`);
  const evidencePath = path.join(outDir, `${opts.label}.evidence.json`);
  const overlayFramePath = path.join(outDir, `${opts.label}.overlay-frame.png`);
  const overlayBeforePath = path.join(outDir, `${opts.label}.overlay-before.png`);
  const preexisting = new Set(
    [
      videoPath,
      evidencePath,
      overlayFramePath,
      overlayBeforePath,
      path.join(outDir, `${opts.label}-frames`),
      path.join(outDir, `${opts.label}-seq`),
    ].filter(existsSync),
  );
  const overwriteWarning =
    opts.mode === "stage"
      ? null
      : formatOverwriteWarning(
          opts.label,
          [videoPath, evidencePath, overlayFramePath, overlayBeforePath].filter(existsSync),
        );
  let stage: Stage | null = null;
  let page: CdpPage | null = null;
  let viewport: { width: number; height: number; dpr: number } | null = null;
  let showMode: ShowMode = opts.windowMode;
  let steps: StepRecord[] = [];
  let phase = "open-stage";
  let sampler: ReturnType<typeof setInterval> | null = null;

  try {
    const opened = await openStage(opts);
    const openedStage = opened.stage;
    const openedPage = opened.page;
    stage = openedStage;
    page = openedPage;
    viewport = opened.viewport;
    showMode = opened.showMode;
    phase = "recorder-start";

    if (opts.mode === "stage") {
      const rect = await openedPage.rect("[data-demo-id='increment']");
      await overlayMove(openedPage, rect.x, rect.y);
      await overlayClick(openedPage, rect.x, rect.y);
      await openedPage.click(rect.x, rect.y);
      console.log(
        JSON.stringify({
          mode: "stage",
          url: opts.url,
          viewport: opened.viewport,
          nodeExposed: opened.nodeExposed,
          electron: process.versions.electron,
          chromium: process.versions.chrome,
        }),
      );
      await new Promise<void>((resolve) => openedStage.window.on("closed", () => resolve()));
      return 0;
    }

    const overwrite = overwriteWarning;
    if (overwrite) console.error(`[malo-browser] ${overwrite}`);
    const recorder = new ScreencastRecorder(openedStage.view.webContents);
    const cpuSamples: number[] = [];
    sampler = setInterval(() => {
      const total = app
        .getAppMetrics()
        .reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage ?? 0), 0);
      cpuSamples.push(Number(total.toFixed(2)));
    }, 500);

    const t0 = Date.now();
    await recorder.start({ quality: 90, maxWidth: 1920, maxHeight: 1080 });
    console.error(
      `[malo-browser] 录制开始 ${opts.seconds}s ${opened.showMode} ${opened.viewport.width}x${opened.viewport.height}`,
    );
    phase = "scenario";
    const scenario = await runScenario(openedPage, opts, t0, steps);
    const highlightAtMs = scenario.highlightAtMs;
    phase = "encode";
    const capture = await recorder.stop();
    if (sampler) {
      clearInterval(sampler);
      sampler = null;
    }

    console.error(`[malo-browser] 编码 ${capture.frames.length} 帧 → ${path.basename(videoPath)}`);
    const encoded = await encodeFrames({
      frames: capture.frames,
      captureStartMs: capture.startedAtMs,
      captureEndMs: capture.stoppedAtMs,
      workDir: outDir,
      outPath: videoPath,
      fps: FPS,
      keepFrames: opts.keepFrames,
    });
    phase = "probe";
    const probe = await probeVideo(videoPath);
    phase = "black-frames";
    const black = await blackReport(videoPath);

    let bluePixels = 0;
    let baselineBluePixels = 0;
    if (!opts.plain) {
      phase = "overlay-frames";
      const framePath = overlayFramePath;
      const beforePath = overlayBeforePath;
      await extractFrame(videoPath, Math.max(0.2, highlightAtMs / 1000 - 0.6), beforePath);
      await extractFrame(videoPath, highlightAtMs / 1000 + 0.35, framePath);
      baselineBluePixels = await countBluePixels(beforePath);
      bluePixels = await countBluePixels(framePath);
    }
    phase = "evidence";
    const sha256 = await sha256File(videoPath);

    const checks: Record<string, { passed: boolean; detail: string }> = {
      node_isolated: { passed: !opened.nodeExposed, detail: `window.require/process/module exposed=${opened.nodeExposed}` },
      frames_arrived: { passed: capture.frames.length > 0, detail: `raw_frames=${capture.frames.length}` },
      duration: {
        passed: Math.abs(probe.durationS - opts.seconds) <= 0.5,
        detail: `video=${probe.durationS.toFixed(2)}s target=${opts.seconds}s`,
      },
      fps: { passed: Math.abs(probe.fps - FPS) < 0.2, detail: `avg_frame_rate=${probe.fps.toFixed(2)}` },
      resolution: {
        passed: probe.width === 1920 && probe.height === 1080,
        detail: `${probe.width}x${probe.height}`,
      },
      black_frames: { passed: black.ratio < 0.5, detail: `black=${black.blackSeconds.toFixed(2)}s ratio=${black.ratio.toFixed(3)}` },
      overlay_in_video: {
        passed: opts.plain ? true : bluePixels - baselineBluePixels > 3000,
        detail: opts.plain
          ? "skipped: plain run has no overlay"
          : `blue_pixels ${baselineBluePixels} -> ${bluePixels} at ${(highlightAtMs / 1000).toFixed(2)}s`,
      },
    };
    const passed = Object.values(checks).every((check) => check.passed);
    const cpuAvg = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : 0;
    const cpuMax = cpuSamples.length ? Math.max(...cpuSamples) : 0;

    phase = "evidence-write";
    await writeJsonAtomic(evidencePath, {
      schema_version: 1,
      kind: "demo-stage-recording",
      status: passed ? "passed" : "failed",
      app: {
        name: "malo-browser",
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
      },
      scene: {
        id: SCENARIO_ID,
        title: "信审复核台 fixture",
        url: opts.url,
        profile: "malo-browser-spike",
        script_sha256: sha256Text(JSON.stringify(SCENARIO)),
      },
      run: {
        mode: opts.mode,
        started_at: startedAtIso,
        ended_at: new Date().toISOString(),
        elapsed_ms: Date.now() - Date.parse(startedAtIso),
        window_mode: opened.showMode,
        headless: opened.showMode === "hidden",
        focus_emulation: opts.focusEmulation,
      },
      capture: {
        method: "electron-cdp-screencast",
        format: "jpeg",
        quality: 90,
        viewport: [opened.viewport.width, opened.viewport.height],
        device_scale_factor: opened.viewport.dpr,
        window_visible: openedStage.window.isVisible(),
        max_frame: [1920, 1080],
        raw_frames: capture.frames.length,
        effective_fps: Number((capture.frames.length / (capture.durationMs / 1000)).toFixed(2)),
        timeline_frames: encoded.slots,
        ack_errors: capture.ackErrors,
      },
      video: {
        file: path.basename(videoPath),
        size: [probe.width, probe.height],
        fps: Number(probe.fps.toFixed(2)),
        frames: probe.frames,
        duration_s: Number(probe.durationS.toFixed(3)),
        sha256,
      },
      cpu: { avg_percent: Number(cpuAvg.toFixed(2)), max_percent: Number(cpuMax.toFixed(2)), samples: cpuSamples },
      checks,
      steps,
      warnings: [
        ...(overwrite ? [`overwrote previous outputs of label ${opts.label}`] : []),
        ...(opened.showMode === "hidden"
          ? ["hidden window capture: verify compositor frames"]
          : [`window mode ${opened.showMode} for capture`]),
      ],
    });

    console.log(
      JSON.stringify({
        label: opts.label,
        status: passed ? "passed" : "failed",
        video: videoPath,
        evidence: evidencePath,
        probe,
        checks,
      }),
    );
    return passed ? 0 : 2;
  } catch (error) {
    if (sampler) {
      clearInterval(sampler);
      sampler = null;
    }
    if (opts.mode !== "stage") {
      try {
        const failedPath = await writeFailedRecordingEvidence({
          outDir,
          label: opts.label,
          opts,
          startedAtIso,
          showMode,
          viewport,
          stageVisible: stage?.window.isVisible() ?? false,
          steps,
          phase,
          error,
          preexisting,
        });
        console.error(`[malo-browser] 失败证据已写入 ${failedPath}`);
      } catch (evidenceError) {
        console.error(`[malo-browser] 写失败证据也失败：${(evidenceError as Error).message}`);
      }
    }
    throw error;
  } finally {
    if (sampler) clearInterval(sampler);
    page?.detach();
    stage?.close();
  }
}
