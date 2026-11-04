import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DemoError } from "../../shared/errors";
import type { Scene } from "../../shared/scene";
import type { RunMode, StepStatus, WindowMode } from "../../shared/types";
import { scriptSha256 as canonicalSceneSha256 } from "../scenes/interpolate";
import type { CaptureSummary } from "../core/ports";

const RUN_MODES: readonly RunMode[] = ["rehearse", "live", "record", "headless"];
const STEP_STATUSES: readonly StepStatus[] = ["pending", "running", "passed", "failed", "skipped"];
const WINDOW_MODES: readonly WindowMode[] = ["hidden", "inactive", "offscreen", "ghost", "focused"];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type EvidenceStatus = "passed" | "failed";

export type EvidenceAppInfo = {
  name: string;
  version: string;
  electron: string;
  chromium: string;
};

export type EvidenceRunInput = {
  mode: RunMode;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  windowMode?: WindowMode;
  headless?: boolean;
  focusEmulation?: boolean;
  sceneIds?: string[];
};

export type EvidenceCaptureInput = {
  method?: string;
  format?: string;
  quality?: number;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  rawFrames?: number;
  effectiveFps?: number;
  timelineFrames?: number;
  ackErrors?: number;
  windowVisible?: boolean;
  headless?: boolean;
};

export type EvidenceCheckInput = {
  passed: boolean;
  detail?: string;
};

export type EvidenceStepInput = {
  index: number;
  id: string;
  action: string;
  note?: string;
  atMs?: number;
  durationMs?: number;
  status: StepStatus;
  detail?: string;
  expected?: unknown;
  actual?: unknown;
};

export type EvidenceErrorInput = {
  code: string;
  message: string;
  stepIndex?: number | null;
  url?: string;
  screenshotPath?: string;
};

export type BuildEvidenceInput = {
  scene: Scene;
  run: EvidenceRunInput;
  capture: EvidenceCaptureInput;
  steps: EvidenceStepInput[];
  checks: Record<string, EvidenceCheckInput>;
  app: EvidenceAppInfo;
  status?: EvidenceStatus;
  video?: CaptureSummary | null;
  error?: EvidenceErrorInput;
  warnings?: string[];
};

export type EvidenceScene = {
  id: string;
  title: string;
  url: string;
  profile: string;
  script_sha256: string;
};

export type EvidenceRun = {
  mode: RunMode;
  started_at: string;
  ended_at: string;
  elapsed_ms: number;
  window_mode?: WindowMode;
  headless?: boolean;
  focus_emulation?: boolean;
  scene_ids?: string[];
};

export type EvidenceCapture = {
  method: string;
  format: string;
  quality: number;
  viewport: [number, number];
  device_scale_factor: number;
  raw_frames?: number;
  effective_fps?: number;
  timeline_frames?: number;
  ack_errors?: number;
  window_visible?: boolean;
  headless?: boolean;
};

export type EvidenceVideo = {
  file: string;
  size: [number, number];
  fps: number;
  frames: number;
  duration_s: number;
  sha256: string;
  partial?: true;
};

export type EvidenceStep = {
  index: number;
  id: string;
  action: string;
  note?: string;
  at_ms?: number;
  duration_ms?: number;
  status: StepStatus;
  detail?: string;
  expected?: unknown;
  actual?: unknown;
};

export type EvidenceCheck = {
  id: string;
  passed: boolean;
  detail: string;
};

export type EvidenceError = {
  code: string;
  message: string;
  step_index?: number | null;
  url?: string;
  screenshot?: string;
};

export type EvidenceDocument = {
  schema_version: 1;
  kind: "demo-stage-recording";
  status: EvidenceStatus;
  app: EvidenceAppInfo;
  scene: EvidenceScene;
  run: EvidenceRun;
  capture: EvidenceCapture;
  video: EvidenceVideo | null;
  steps: EvidenceStep[];
  checks: EvidenceCheck[];
  warnings: string[];
  error?: EvidenceError;
};

function assertText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 不能为空`);
  }
  return value;
}

function assertFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 必须是有限数字：${String(value)}`);
  }
  return value;
}

function assertPositive(value: unknown, label: string): number {
  const number = assertFinite(value, label);
  if (number <= 0) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 必须大于 0：${number}`);
  }
  return number;
}

function assertNonNegative(value: unknown, label: string): number {
  const number = assertFinite(value, label);
  if (number < 0) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 不能为负数：${number}`);
  }
  return number;
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  const number = assertNonNegative(value, label);
  if (!Number.isInteger(number)) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 必须是整数：${number}`);
  }
  return number;
}

function assertPositiveInteger(value: unknown, label: string): number {
  const number = assertPositive(value, label);
  if (!Number.isInteger(number)) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 必须是整数：${number}`);
  }
  return number;
}

function assertBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 必须是布尔值`);
  }
  return value;
}

function assertIsoTime(value: unknown, label: string): string {
  const text = assertText(value, label);
  if (Number.isNaN(Date.parse(text))) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `${label} 不是合法时间：${text}`);
  }
  return text;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return hash.digest("hex");
}

export function sceneScriptSha256(scene: Scene): string {
  return canonicalSceneSha256(scene);
}

function resolveSceneUrl(scene: Scene): string {
  if (scene.url) return scene.url;
  if (scene.file) return pathToFileURL(path.resolve(scene.rootDir, scene.file)).href;
  throw new DemoError("E_SCENE_INVALID", `场景 ${scene.id} 既没有 url 也没有 file`);
}

function normalizeRun(run: EvidenceRunInput): EvidenceRun {
  if (!RUN_MODES.includes(run.mode)) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `run.mode 非法：${String(run.mode)}`);
  }
  const result: EvidenceRun = {
    mode: run.mode,
    started_at: assertIsoTime(run.startedAt, "run.startedAt"),
    ended_at: assertIsoTime(run.endedAt, "run.endedAt"),
    elapsed_ms: Math.round(assertNonNegative(run.elapsedMs, "run.elapsedMs")),
  };
  if (run.windowMode !== undefined) {
    if (!WINDOW_MODES.includes(run.windowMode)) {
      throw new DemoError("E_EVIDENCE_MISMATCH", `run.windowMode 非法：${String(run.windowMode)}`);
    }
    result.window_mode = run.windowMode;
  }
  if (run.headless !== undefined) result.headless = assertBoolean(run.headless, "run.headless");
  if (run.focusEmulation !== undefined) {
    result.focus_emulation = assertBoolean(run.focusEmulation, "run.focusEmulation");
  }
  if (run.sceneIds !== undefined) {
    if (!Array.isArray(run.sceneIds) || run.sceneIds.length === 0) {
      throw new DemoError("E_EVIDENCE_MISMATCH", "run.sceneIds 必须是非空数组");
    }
    result.scene_ids = run.sceneIds.map((sceneId, index) =>
      assertText(sceneId, `run.sceneIds[${index}]`),
    );
  }
  return result;
}

function normalizeCapture(capture: EvidenceCaptureInput): EvidenceCapture {
  const quality = capture.quality ?? 90;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `capture.quality 必须在 1-100：${quality}`);
  }
  const result: EvidenceCapture = {
    method: capture.method === undefined ? "electron-cdp-screencast" : assertText(capture.method, "capture.method"),
    format: capture.format === undefined ? "jpeg" : assertText(capture.format, "capture.format"),
    quality,
    viewport: [
      Math.round(assertPositive(capture.viewport?.width, "capture.viewport.width")),
      Math.round(assertPositive(capture.viewport?.height, "capture.viewport.height")),
    ],
    device_scale_factor: assertPositive(capture.deviceScaleFactor, "capture.deviceScaleFactor"),
  };
  if (capture.rawFrames !== undefined) {
    result.raw_frames = assertNonNegativeInteger(capture.rawFrames, "capture.rawFrames");
  }
  if (capture.effectiveFps !== undefined) {
    result.effective_fps = Number(
      assertNonNegative(capture.effectiveFps, "capture.effectiveFps").toFixed(2),
    );
  }
  if (capture.timelineFrames !== undefined) {
    result.timeline_frames = assertNonNegativeInteger(capture.timelineFrames, "capture.timelineFrames");
  }
  if (capture.ackErrors !== undefined) {
    result.ack_errors = assertNonNegativeInteger(capture.ackErrors, "capture.ackErrors");
  }
  if (capture.windowVisible !== undefined) {
    result.window_visible = assertBoolean(capture.windowVisible, "capture.windowVisible");
  }
  if (capture.headless !== undefined) {
    result.headless = assertBoolean(capture.headless, "capture.headless");
  }
  return result;
}

function normalizeSteps(steps: EvidenceStepInput[]): EvidenceStep[] {
  return steps.map((step) => {
    const index = assertNonNegativeInteger(step.index, "steps.index");
    if (!STEP_STATUSES.includes(step.status)) {
      throw new DemoError("E_EVIDENCE_MISMATCH", `steps[${index}].status 非法：${String(step.status)}`);
    }
    const result: EvidenceStep = {
      index,
      id: assertText(step.id, `steps[${index}].id`),
      action: assertText(step.action, `steps[${index}].action`),
      status: step.status,
    };
    if (step.note !== undefined) {
      if (typeof step.note !== "string") {
        throw new DemoError("E_EVIDENCE_MISMATCH", `steps[${index}].note 必须是字符串`);
      }
      result.note = step.note;
    }
    if (step.atMs !== undefined) {
      result.at_ms = Math.round(assertNonNegative(step.atMs, `steps[${index}].atMs`));
    }
    if (step.durationMs !== undefined) {
      result.duration_ms = Math.round(
        assertNonNegative(step.durationMs, `steps[${index}].durationMs`),
      );
    }
    if (step.detail !== undefined) {
      if (typeof step.detail !== "string") {
        throw new DemoError("E_EVIDENCE_MISMATCH", `steps[${index}].detail 必须是字符串`);
      }
      result.detail = step.detail;
    }
    if (step.expected !== undefined) result.expected = step.expected;
    if (step.actual !== undefined) result.actual = step.actual;
    return result;
  });
}

function normalizeChecks(checks: Record<string, EvidenceCheckInput>): EvidenceCheck[] {
  return Object.keys(checks)
    .sort()
    .map((id) => {
      const check = checks[id];
      if (typeof check?.passed !== "boolean") {
        throw new DemoError("E_EVIDENCE_MISMATCH", `checks.${id}.passed 必须是布尔值`);
      }
      if (check.detail !== undefined && typeof check.detail !== "string") {
        throw new DemoError("E_EVIDENCE_MISMATCH", `checks.${id}.detail 必须是字符串`);
      }
      return { id, passed: check.passed, detail: check.detail ?? "" };
    });
}

function normalizeVideo(
  video: CaptureSummary | null | undefined,
  status: EvidenceStatus,
): EvidenceVideo | null {
  if (!video) return null;
  const file = path.basename(assertText(video.file, "video.file"));
  if (!SHA256_PATTERN.test(video.sha256)) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `video.sha256 非法：${video.sha256}`);
  }
  const result: EvidenceVideo = {
    file,
    size: [
      Math.round(assertPositive(video.width, "video.width")),
      Math.round(assertPositive(video.height, "video.height")),
    ],
    fps: Number(assertPositive(video.fps, "video.fps").toFixed(2)),
    frames: assertPositiveInteger(video.frames, "video.frames"),
    duration_s: Number(assertPositive(video.durationS, "video.durationS").toFixed(3)),
    sha256: video.sha256,
  };
  if (status === "failed") result.partial = true;
  return result;
}

function normalizeError(error: EvidenceErrorInput): EvidenceError {
  const result: EvidenceError = {
    code: assertText(error.code, "error.code"),
    message: assertText(error.message, "error.message"),
  };
  if (error.stepIndex !== undefined) {
    if (error.stepIndex !== null) {
      assertNonNegativeInteger(error.stepIndex, "error.stepIndex");
    }
    result.step_index = error.stepIndex;
  }
  if (error.url !== undefined) result.url = error.url;
  if (error.screenshotPath !== undefined) result.screenshot = error.screenshotPath;
  return result;
}

export function buildEvidence(input: BuildEvidenceInput): EvidenceDocument {
  const app: EvidenceAppInfo = {
    name: assertText(input.app.name, "app.name"),
    version: assertText(input.app.version, "app.version"),
    electron: assertText(input.app.electron, "app.electron"),
    chromium: assertText(input.app.chromium, "app.chromium"),
  };
  const scene: EvidenceScene = {
    id: assertText(input.scene.id, "scene.id"),
    title: assertText(input.scene.title, "scene.title"),
    url: resolveSceneUrl(input.scene),
    profile: assertText(input.scene.profile, "scene.profile"),
    script_sha256: sceneScriptSha256(input.scene),
  };
  const run = normalizeRun(input.run);
  const capture = normalizeCapture(input.capture);
  const steps = normalizeSteps(input.steps);
  const checks = normalizeChecks(input.checks);
  const warnings = (input.warnings ?? []).map((warning, index) =>
    assertText(warning, `warnings[${index}]`),
  );

  const hasFailedCheck = checks.some((check) => !check.passed);
  if (input.status !== undefined && input.status !== "passed" && input.status !== "failed") {
    throw new DemoError("E_EVIDENCE_MISMATCH", `status 非法：${String(input.status)}`);
  }
  const status: EvidenceStatus =
    input.error !== undefined || input.status === "failed" || hasFailedCheck ? "failed" : "passed";
  const video = normalizeVideo(input.video, status);

  const document: EvidenceDocument = {
    schema_version: 1,
    kind: "demo-stage-recording",
    status,
    app,
    scene,
    run,
    capture,
    video,
    steps,
    checks,
    warnings,
  };
  if (input.error !== undefined) {
    document.error = normalizeError(input.error);
  } else if (status === "failed") {
    const failedChecks = checks.filter((check) => !check.passed).map((check) => check.id);
    document.error = {
      code: "E_EVIDENCE_MISMATCH",
      message:
        failedChecks.length > 0
          ? `自检失败：${failedChecks.join(", ")}`
          : "录制被标记为失败",
    };
  }
  return document;
}

export async function writeEvidence(file: string, evidence: EvidenceDocument): Promise<void> {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await rename(tmp, target);
}
