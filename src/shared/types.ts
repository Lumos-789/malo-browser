export type RunMode = "rehearse" | "live" | "record" | "headless";

export type RunStatus =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "paused"
  | "failed"
  | "done";

export type RecorderState = "idle" | "starting" | "recording" | "stopping" | "failed";

export type WindowMode = "hidden" | "inactive" | "offscreen" | "ghost" | "focused";

export type Point = { x: number; y: number };

export type Rect = {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export type StepRecord = {
  index: number;
  id: string;
  action: string;
  note?: string;
  atMs?: number;
  durationMs?: number;
  status: StepStatus;
  detail?: string;
};

export type AppSnapshot = {
  schemaVersion: 1;
  app: {
    version: string;
    electron: string;
    chromium: string;
  };
  stage: {
    sceneId: string | null;
    title: string;
    url: string;
    visible: boolean;
    blackout: boolean;
    fullscreen: boolean;
    displayId: number | null;
    viewport: { width: number; height: number; dpr: number };
  };
  run: {
    mode: RunMode;
    status: RunStatus;
    stepIndex: number;
    stepTotal: number;
    steps: StepRecord[];
    startedAt: string | null;
    elapsedMs: number;
  };
  recorder: {
    status: RecorderState;
    outputPath: string | null;
    frames: number;
    elapsedMs: number;
  };
  error: null | {
    code: string;
    message: string;
    stepIndex: number | null;
    screenshotPath: string | null;
  };
};

export type AppEvent =
  | { type: "scene.loading"; sceneId: string }
  | { type: "scene.ready"; sceneId: string; url: string }
  | { type: "stage.layout"; fullscreen: boolean; displayId: number | null; viewport: { width: number; height: number; dpr: number } }
  | { type: "step.started"; index: number; id: string; action: string }
  | { type: "step.completed"; index: number; id: string; durationMs: number }
  | { type: "step.failed"; index: number; id: string; message: string }
  | { type: "run.paused"; stepIndex: number }
  | { type: "run.completed"; stepTotal: number }
  | { type: "recorder.started"; outputPath: string }
  | { type: "recorder.stopped"; outputPath: string; frames: number }
  | { type: "app.error"; code: string; message: string }
  | { type: "state.changed"; snapshot: AppSnapshot };

export type DisplaySummary = {
  id: number;
  label: string;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
};

export type ControlCommand =
  | { cmd: "scene.load"; args: { sceneId: string } }
  | { cmd: "run.start"; args: { mode: RunMode } }
  | { cmd: "run.next"; args: Record<string, never> }
  | { cmd: "run.prev"; args: Record<string, never> }
  | { cmd: "run.pause"; args: Record<string, never> }
  | { cmd: "run.resume"; args: Record<string, never> }
  | { cmd: "run.reset"; args: { policy?: "reload" | "clear-storage" | "new-session" } }
  | { cmd: "stage.blackout"; args: { on: boolean } }
  | { cmd: "stage.fullscreen"; args: { on: boolean } }
  | { cmd: "stage.display"; args: { displayId: number | null } }
  | { cmd: "recorder.start"; args: { output?: string } }
  | { cmd: "recorder.stop"; args: Record<string, never> };
