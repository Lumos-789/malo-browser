import { app } from "electron";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import type { Options } from "./cli";
import { CdpPage } from "./cdp-page";
import { sha256File, sha256Text, writeJsonAtomic } from "./evidence";
import { injectOverlay, overlayClick, overlayHighlight, overlayMove } from "./overlay";
import { ScreencastRecorder } from "./recorder";
import { createStage, type ShowMode } from "./stage-window";
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
): Promise<{ steps: StepRecord[]; highlightAtMs: number }> {
  const steps: StepRecord[] = [];
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
    return { steps, highlightAtMs };
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

  return { steps, highlightAtMs };
}

async function openStage(opts: Options) {
  const showMode: ShowMode = opts.windowMode;
  if (process.env.DEMO_DEBUG) console.error("[malo-browser] opening stage");
  const stage = createStage({ width: opts.width, height: opts.height, showMode });
  const page = new CdpPage(stage.view.webContents);
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
}

export async function runPhase0(opts: Options): Promise<number> {
  const outDir = path.resolve(opts.outDir);
  await mkdir(outDir, { recursive: true });
  const startedAtIso = new Date().toISOString();
  const opened = await openStage(opts);
  const { stage, page, viewport, nodeExposed, showMode } = opened;

  if (opts.mode === "stage") {
    const rect = await page.rect("[data-demo-id='increment']");
    await overlayMove(page, rect.x, rect.y);
    await overlayClick(page, rect.x, rect.y);
    await page.click(rect.x, rect.y);
    console.log(
      JSON.stringify({
        mode: "stage",
        url: opts.url,
        viewport,
        nodeExposed,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
      }),
    );
    await new Promise<void>((resolve) => stage.window.on("closed", () => resolve()));
    return 0;
  }

  const videoPath = path.join(outDir, `${opts.label}.mp4`);
  const evidencePath = path.join(outDir, `${opts.label}.evidence.json`);
  const overlayFramePath = path.join(outDir, `${opts.label}.overlay-frame.png`);
  const overlayBeforePath = path.join(outDir, `${opts.label}.overlay-before.png`);
  const overwriteWarning = formatOverwriteWarning(opts.label, [videoPath, evidencePath, overlayFramePath, overlayBeforePath].filter(existsSync));
  if (overwriteWarning) console.error(`[malo-browser] ${overwriteWarning}`);
  const recorder = new ScreencastRecorder(stage.view.webContents);
  const cpuSamples: number[] = [];
  const sampler = setInterval(() => {
    const total = app
      .getAppMetrics()
      .reduce((sum, metric) => sum + (metric.cpu?.percentCPUUsage ?? 0), 0);
    cpuSamples.push(Number(total.toFixed(2)));
  }, 500);

  try {
    const t0 = Date.now();
    await recorder.start({ quality: 90, maxWidth: 1920, maxHeight: 1080 });
    console.error(`[malo-browser] 录制开始 ${opts.seconds}s ${showMode} ${viewport.width}x${viewport.height}`);
    const { steps, highlightAtMs } = await runScenario(page, opts, t0);
    const capture = await recorder.stop();
    clearInterval(sampler);

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
    const probe = await probeVideo(videoPath);
    const black = await blackReport(videoPath);

    let bluePixels = 0;
    let baselineBluePixels = 0;
    if (!opts.plain) {
      const framePath = overlayFramePath;
      const beforePath = overlayBeforePath;
      await extractFrame(videoPath, Math.max(0.2, highlightAtMs / 1000 - 0.6), beforePath);
      await extractFrame(videoPath, highlightAtMs / 1000 + 0.35, framePath);
      baselineBluePixels = await countBluePixels(beforePath);
      bluePixels = await countBluePixels(framePath);
    }
    const sha256 = await sha256File(videoPath);

    const checks: Record<string, { passed: boolean; detail: string }> = {
      node_isolated: { passed: !nodeExposed, detail: `window.require/process/module exposed=${nodeExposed}` },
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
        window_mode: showMode,
        headless: showMode === "hidden",
        focus_emulation: opts.focusEmulation,
      },
      capture: {
        method: "electron-cdp-screencast",
        format: "jpeg",
        quality: 90,
        viewport: [viewport.width, viewport.height],
        device_scale_factor: viewport.dpr,
        window_visible: stage.window.isVisible(),
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
        ...(overwriteWarning ? [`overwrote previous outputs of label ${opts.label}`] : []),
        ...(showMode === "hidden"
          ? ["hidden window capture: verify compositor frames"]
          : [`window mode ${showMode} for capture`]),
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
    clearInterval(sampler);
    await writeJsonAtomic(evidencePath, {
      schema_version: 1,
      kind: "demo-stage-recording",
      status: "failed",
      app: {
        name: "malo-browser",
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
      },
      scene: { id: SCENARIO_ID, title: "信审复核台 fixture", url: opts.url },
      run: { mode: opts.mode, started_at: startedAtIso, ended_at: new Date().toISOString(), window_mode: showMode },
      video: null,
      error: { message: (error as Error).message },
    });
    throw error;
  } finally {
    page.detach();
    stage.close();
  }
}
