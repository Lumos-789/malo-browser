export const ERROR_CODES = [
  "E_SCENE_NOT_FOUND",
  "E_SCENE_INVALID",
  "E_ACCOUNT_NOT_FOUND",
  "E_ACCOUNT_INVALID",
  "E_PROFILE_LOCKED",
  "E_NAV_BLOCKED",
  "E_NAV_FAILED",
  "E_PERMISSION_DENIED",
  "E_STEP_TIMEOUT",
  "E_SELECTOR_NOT_FOUND",
  "E_ASSERTION_FAILED",
  "E_CDP_ATTACH_FAILED",
  "E_RECORDER_NO_FRAMES",
  "E_FFMPEG_MISSING",
  "E_FFMPEG_FAILED",
  "E_EVIDENCE_MISMATCH",
  "E_CONTROL_UNAUTHORIZED",
  "E_STAGE_LAYOUT",
  "E_SESSION_NOT_FOUND",
  "E_LEASE_NOT_FOUND",
  "E_LEASE_EXPIRED",
  "E_RESOURCE_LIMIT",
  "E_BAD_REQUEST",
  "E_UNSUPPORTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorDetail = {
  code: ErrorCode;
  message: string;
  sceneId?: string;
  stepIndex?: number | null;
  url?: string;
  selector?: string;
  screenshotPath?: string;
  details?: Record<string, unknown>;
};

export class DemoError extends Error {
  readonly code: ErrorCode;
  readonly sceneId?: string;
  readonly stepIndex?: number | null;
  readonly url?: string;
  readonly selector?: string;
  readonly screenshotPath?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, extra: Omit<Partial<ErrorDetail>, "code" | "message"> = {}) {
    super(`${code}: ${message}`);
    this.name = "DemoError";
    this.code = code;
    this.sceneId = extra.sceneId;
    this.stepIndex = extra.stepIndex;
    this.url = extra.url;
    this.selector = extra.selector;
    this.screenshotPath = extra.screenshotPath;
    this.details = extra.details;
  }

  toDetail(): ErrorDetail {
    return {
      code: this.code,
      message: this.message,
      sceneId: this.sceneId,
      stepIndex: this.stepIndex,
      url: this.url,
      selector: this.selector,
      screenshotPath: this.screenshotPath,
      details: this.details,
    };
  }
}

export function isDemoError(error: unknown): error is DemoError {
  return error instanceof DemoError;
}

export function stripErrorCode(code: string, message: string): string {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

const CHROMIUM_ERROR_PATTERN = /\b(ERR_[A-Z0-9_]+)\b/;
const CODE_PATTERN = /\b(E_[A-Z0-9_]+)\b/;

export function errorCodeFor(error: unknown): string {
  const candidate = (error as { code?: unknown } | null)?.code;
  if (typeof candidate === "string" && /^(?:E_|ERR_)[A-Z0-9_]+$/.test(candidate)) {
    return candidate;
  }
  const message = error instanceof Error ? error.message : String(error);
  const chromium = CHROMIUM_ERROR_PATTERN.exec(message);
  if (chromium) return chromium[1];
  const demo = CODE_PATTERN.exec(message);
  if (demo) return demo[1];
  return "E_RECORDER_FAILED";
}
