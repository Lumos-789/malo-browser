import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.2",
    getAppPath: () => "/tmp/malo-test-app",
    dock: { hide: () => undefined, show: () => undefined },
  },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ id: 1 }),
  },
  BaseWindow: class {},
  WebContentsView: class {},
  ipcMain: { handle: () => undefined },
}));

import { AppController } from "../../src/main/app-controller";
import { DemoError } from "../../src/shared/errors";
import type { Scene } from "../../src/shared/scene";

type ControllerInternals = {
  snap: {
    stage: { visible: boolean; viewport: { width: number; height: number; dpr: number } };
    run: { mode: string; startedAt: string | null; steps: unknown[] };
    recorder: { status: string; outputPath: string | null; frames: number; elapsedMs: number };
    error: unknown;
  };
  recorder: { stop(): Promise<unknown> } | null;
  recordingScene: Scene | null;
  recordingStartedAtMs: number | null;
  takeSteps: unknown[];
  runSceneIds: string[];
};

function internals(controller: AppController): ControllerInternals {
  return controller as unknown as ControllerInternals;
}

function fakeScene(rootDir: string): Scene {
  return {
    schemaVersion: 1,
    id: "report-review",
    title: "Report Review",
    url: "demo://scene/report-review/index.html",
    viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    profile: "demo",
    allow: [],
    permissions: [],
    resetPolicy: "reload",
    vars: {},
    steps: [],
    rootDir,
  };
}

function evidencePathFor(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, ".evidence.json");
}

type Harness = {
  controller: AppController;
  state: ControllerInternals;
  scene: Scene;
  output: string;
  evidencePath: string;
};

async function startHarness(output: string): Promise<Harness> {
  const scene = fakeScene(path.join(path.dirname(output), "scenes", "report-review"));
  const controller = new AppController({
    scenesRoot: path.dirname(scene.rootDir),
    outputRoot: path.dirname(path.dirname(output)),
    windowMode: "hidden",
  });
  const state = internals(controller);
  state.recordingScene = scene;
  state.recordingStartedAtMs = Date.now() - 1_234;
  state.runSceneIds = [scene.id];
  state.snap.stage.visible = false;
  state.snap.stage.viewport = { width: 1440, height: 900, dpr: 2 };
  state.snap.run = {
    mode: "record",
    startedAt: new Date(Date.now() - 2_000).toISOString(),
    steps: [],
  };
  state.snap.error = null;
  state.snap.recorder = { status: "recording", outputPath: output, frames: 0, elapsedMs: 0 };
  return { controller, state, scene, output, evidencePath: evidencePathFor(output) };
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), "malo-take-evidence-"));
  // Vitest runs on plain Node: fill the Electron version fields buildEvidence requires.
  Object.defineProperty(process.versions, "electron", { value: "45.1.0", configurable: true });
  Object.defineProperty(process.versions, "chrome", {
    value: "156.0.8078.49",
    configurable: true,
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("failed take evidence", () => {
  it("writes video:null failed evidence when the recorder captures zero frames", async () => {
    const output = path.join(
      workDir,
      "out",
      "recordings",
      "2026-11-04_19-00-00_report-review",
      "take-01.mp4",
    );
    const harness = await startHarness(output);
    harness.state.recorder = {
      stop: async () => {
        throw new DemoError("E_RECORDER_NO_FRAMES", "录制 1.234s 没有收到任何画面帧", {
          details: { started_at_ms: 1, stopped_at_ms: 2 },
        });
      },
    };

    const failure = await harness.controller.recordStop().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DemoError);
    expect((failure as DemoError).code).toBe("E_RECORDER_NO_FRAMES");

    const evidence = JSON.parse(await readFile(harness.evidencePath, "utf8"));
    expect(evidence.schema_version).toBe(1);
    expect(evidence.kind).toBe("demo-stage-recording");
    expect(evidence.status).toBe("failed");
    expect(evidence.video).toBeNull();
    expect(evidence.scene.id).toBe("report-review");
    expect(evidence.error).toMatchObject({
      code: "E_RECORDER_NO_FRAMES",
      message: "录制 1.234s 没有收到任何画面帧",
    });
    expect(evidence.error.message).not.toContain("E_RECORDER_NO_FRAMES:");
    expect(evidence.capture.raw_frames).toBe(0);
    expect(evidence.capture.viewport).toEqual([1440, 900]);
    expect(evidence.capture.device_scale_factor).toBe(2);
    expect(evidence.run.mode).toBe("record");
    expect(evidence.run.scene_ids).toEqual(["report-review"]);
    const framesCheck = evidence.checks.find(
      (check: { id: string }) => check.id === "frames_arrived",
    );
    expect(framesCheck.passed).toBe(false);
    expect(evidence.warnings[0]).toContain("no video was written");

    expect(harness.state.recorder).toBeNull();
    expect(harness.state.recordingScene).toBeNull();
    expect(harness.state.snap.recorder).toMatchObject({ status: "failed", frames: 0 });
  });

  it("still writes passed evidence with a video when the take stops normally", async () => {
    const output = path.join(workDir, "out", "recordings", "take-ok", "take-01.mp4");
    const harness = await startHarness(output);
    harness.state.takeSteps = [
      { index: 0, id: "ready", action: "wait_for", status: "passed", durationMs: 900 },
    ];
    harness.state.recorder = {
      stop: async () => ({
        file: output,
        frames: 60,
        durationS: 2,
        width: 1440,
        height: 900,
        fps: 30,
        sha256: "a".repeat(64),
        rawFrames: 61,
        ackErrors: 0,
        expectedDurationS: 2,
        timelineFrames: 60,
        blackRatio: 0,
        probe: { frames: 60, durationS: 2, width: 1440, height: 900, fps: 30 },
      }),
    };

    await harness.controller.recordStop();

    const evidence = JSON.parse(await readFile(harness.evidencePath, "utf8"));
    expect(evidence.status).toBe("passed");
    expect(evidence.video).toMatchObject({ file: "take-01.mp4", frames: 60 });
    expect(evidence.video.partial).toBeUndefined();
    expect(evidence.run.scene_ids).toEqual(["report-review"]);
    expect(harness.state.snap.recorder.status).toBe("idle");
  });
});
