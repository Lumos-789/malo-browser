import { DemoError, isDemoError } from "../../shared/errors";
import { MALO_TOOL_NAMES } from "../../shared/malo-tools";
import type {
  MaloAction,
  MaloActionResult,
  MaloAssertCheck,
  MaloAssertFailure,
  MaloAssertInput,
  MaloAssertResult,
  MaloExtractResult,
  MaloLightObservation,
  MaloLoginInput,
  MaloLoginResult,
  MaloNetworkCaptureState,
  MaloObservation,
  MaloResponsesResult,
  MaloRunReport,
  MaloRunStepResult,
  MaloSessionEvent,
  MaloSnapshot,
  MaloWatchResult,
} from "../../shared/malo";

export type MaloToolSession = {
  navigate(url: string, timeoutMs?: number, settleMs?: number): Promise<MaloLightObservation>;
  observe(mode: "light" | "screenshot", maxChars?: number): Promise<MaloObservation>;
  snapshot(maxChars?: number, maxItems?: number): Promise<MaloSnapshot>;
  extract(input: {
    selector: string;
    mode?: "text" | "html" | "attributes";
    attributes?: string[];
    maxChars?: number;
    all?: boolean;
  }): Promise<MaloExtractResult>;
  assertExpectations(input: MaloAssertInput): Promise<MaloAssertResult>;
  saveRunReport(report: Omit<MaloRunReport, "report_path">): Promise<string>;
  act(action: MaloAction, timeoutMs?: number): Promise<MaloActionResult>;
  watch(input?: {
    show?: boolean;
    focus?: boolean;
    width?: number;
    height?: number;
  }): Promise<MaloWatchResult>;
  login(input: MaloLoginInput): Promise<MaloLoginResult>;
  networkCapture(input: { url_prefixes?: string[] }): Promise<MaloNetworkCaptureState>;
  responses(input: {
    url_prefix?: string;
    after?: number;
    limit?: number;
  }): Promise<MaloResponsesResult>;
  eventsAfter(after: number, limit?: number): MaloSessionEvent[];
  close(): Promise<void>;
};

function bad(message: string): DemoError {
  return new DemoError("E_BAD_REQUEST", message);
}

function readString(args: Record<string, unknown>, field: string, required = true): string | undefined {
  const value = args[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw bad(`${field} 必须是非空字符串`);
  return value;
}

function readInteger(
  args: Record<string, unknown>,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[field];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw bad(`${field} 必须是 ${min}-${max} 的整数`);
  }
  return number;
}

export async function invokeMaloTool(
  tool: string,
  args: Record<string, unknown>,
  session: MaloToolSession,
): Promise<{ tool: string; result: unknown }> {
  let result: unknown;
  switch (tool) {
    case "navigate": {
      const url = readString(args, "url")!;
      result = await session.navigate(
        url,
        readInteger(args, "timeout_ms", 30_000, 100, 120_000),
        readInteger(args, "settle_ms", 6_000, 0, 15_000),
      );
      break;
    }
    case "observe": {
      const mode = args.mode ?? "light";
      if (mode !== "light" && mode !== "screenshot") throw bad("mode 只能是 light 或 screenshot");
      result = await session.observe(mode, readInteger(args, "max_chars", 2_000, 0, 20_000));
      break;
    }
    case "snapshot":
      result = await session.snapshot(
        readInteger(args, "max_chars", 8_000, 0, 30_000),
        readInteger(args, "max_items", 120, 1, 500),
      );
      break;
    case "extract": {
      const mode = args.mode ?? "text";
      if (mode !== "text" && mode !== "html" && mode !== "attributes") {
        throw bad("mode 只能是 text / html / attributes");
      }
      if (args.attributes !== undefined && !Array.isArray(args.attributes)) {
        throw bad("attributes 必须是字符串数组");
      }
      if (Array.isArray(args.attributes)) {
        const invalid = args.attributes.find((item) => typeof item !== "string" || item === "");
        if (invalid !== undefined) {
          throw bad(`attributes 条目必须是非空字符串，非法项: ${JSON.stringify(invalid)}`);
        }
      }
      result = await session.extract({
        selector: readString(args, "selector")!,
        mode,
        attributes: Array.isArray(args.attributes)
          ? (args.attributes as string[])
          : undefined,
        maxChars: readInteger(args, "max_chars", 4_000, 0, 20_000),
        all: args.all !== false,
      });
      break;
    }
    case "events": {
      const events = session.eventsAfter(
        readInteger(args, "after", 0, 0, Number.MAX_SAFE_INTEGER),
        readInteger(args, "limit", 100, 1, 200),
      );
      result = { events };
      break;
    }
    case "network_capture": {
      let prefixes: string[] | undefined;
      if (args.url_prefixes !== undefined) {
        if (!Array.isArray(args.url_prefixes)) throw bad("url_prefixes 必须是字符串数组");
        for (const prefix of args.url_prefixes) {
          if (typeof prefix !== "string" || prefix.trim() === "") {
            throw bad("url_prefixes 必须是非空字符串数组");
          }
        }
        prefixes = args.url_prefixes as string[];
      }
      result = await session.networkCapture({ url_prefixes: prefixes });
      break;
    }
    case "responses": {
      result = await session.responses({
        url_prefix: readString(args, "url_prefix", false),
        after: readInteger(args, "after", 0, 0, Number.MAX_SAFE_INTEGER),
        limit: readInteger(args, "limit", 50, 1, 200),
      });
      break;
    }
    case "assert": {
      const input: MaloAssertInput = {
        visible: readString(args, "visible", false),
        hidden: readString(args, "hidden", false),
        text: readString(args, "text", false),
        selector: readString(args, "selector", false),
        value: readString(args, "value", false),
        url: readString(args, "url", false),
        count:
          args.count === undefined
            ? undefined
            : readInteger(args, "count", 0, 0, 1_000_000),
        timeout_ms: readInteger(args, "timeout_ms", 5_000, 0, 120_000),
      };
      if (
        input.visible === undefined &&
        input.hidden === undefined &&
        input.text === undefined &&
        input.value === undefined &&
        input.url === undefined &&
        input.count === undefined
      ) {
        throw bad("assert 至少需要一个断言条件");
      }
      if ((input.value !== undefined || input.count !== undefined) && input.selector === undefined) {
        throw bad("assert value/count 需要 selector");
      }
      result = await session.assertExpectations(input);
      break;
    }
    case "run_steps": {
      const steps = readSteps(args.steps);
      result = await runSteps(steps, args.stop_on_failure !== false, session);
      break;
    }
    case "watch":
      result = await session.watch({
        show: args.show !== false,
        focus: args.focus === true,
        width: readOptionalInteger(args, "width", 640, 3840),
        height: readOptionalInteger(args, "height", 480, 2160),
      });
      break;
    case "login": {
      const mode = args.mode ?? "auto";
      if (mode !== "auto" && mode !== "password" && mode !== "watch") {
        throw bad("mode 只能是 auto / password / watch");
      }
      result = await session.login({
        mode,
        username: readString(args, "username", false),
        password: readString(args, "password", false),
        username_selector: readString(args, "username_selector", false),
        password_selector: readString(args, "password_selector", false),
        submit_selector: readString(args, "submit_selector", false),
        success_url_contains: readString(args, "success_url_contains", false),
        success_selector: readString(args, "success_selector", false),
        error_selector: readString(args, "error_selector", false),
        timeout_ms: readInteger(args, "timeout_ms", mode === "watch" ? 180_000 : 30_000, 1_000, 600_000),
        focus: args.focus === true,
        keep_visible: args.keep_visible === true,
      });
      break;
    }
    case "close":
      await session.close();
      result = { closed: true };
      break;
    case "click":
    case "fill":
    case "upload_file":
    case "press":
    case "hover":
    case "select":
    case "focus":
    case "scroll":
    case "scroll_into_view":
    case "wait_for":
    case "history":
    case "sleep":
      result = await session.act({ ...args, type: tool } as MaloAction);
      break;
    default:
      throw new DemoError("E_UNSUPPORTED", `未知工具：${tool}`);
  }
  return { tool, result };
}

/**
 * An assertion failure is a verdict about the page, not a broken request: the
 * HTTP layer answers 200 with this payload so callers read `result.ok` instead
 * of treating the response status as the verdict. Other errors keep their
 * transport status (4xx for bad arguments, 5xx for real server failures).
 */
export function assertFailureResult(error: unknown): MaloAssertFailure | null {
  if (!isDemoError(error) || error.code !== "E_ASSERTION_FAILED") return null;
  const detail = error.toDetail();
  const checks = Array.isArray(detail.details?.checks)
    ? (detail.details.checks as MaloAssertCheck[])
    : [];
  const waited = detail.details?.waited_ms;
  const details: Record<string, unknown> = { ...(detail.details ?? {}) };
  if (detail.screenshotPath) details.screenshotPath = detail.screenshotPath;
  return {
    ok: false,
    passed: false,
    checks,
    ...(detail.url ? { url: detail.url } : {}),
    ...(typeof waited === "number" ? { waited_ms: waited } : {}),
    ...(detail.screenshotPath ? { screenshot: detail.screenshotPath } : {}),
    error: { code: "E_ASSERTION_FAILED", message: detail.message, details },
  };
}

// network_capture and responses are session controls; responses also carries
// body text, which must never reach the run report written by run_steps.
// login is blocked because it can open a handoff window (mode=watch) and type
// credentials, which a batch run must not do silently.
const RUN_STEP_BLOCKED = new Set([
  "run_steps",
  "close",
  "watch",
  "login",
  "profiles",
  "network_capture",
  "responses",
]);

type RunStep = { type: string; args: Record<string, unknown> };

function readSteps(raw: unknown): RunStep[] {
  if (!Array.isArray(raw)) throw bad("steps 必须是数组");
  if (raw.length === 0) throw bad("steps 不能为空");
  if (raw.length > 200) throw bad("steps 最多 200 步");
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw bad(`steps[${index}] 必须是对象`);
    }
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string" || type.trim() === "") {
      throw bad(`steps[${index}].type 必须是非空字符串`);
    }
    if (!MALO_TOOL_NAMES.has(type)) throw bad(`steps[${index}].type 是未知工具：${type}`);
    if (RUN_STEP_BLOCKED.has(type)) {
      throw bad(`steps[${index}].type 不能在 run_steps 内调用：${type}`);
    }
    const args = { ...record };
    delete args.type;
    return { type, args };
  });
}

async function runSteps(
  steps: RunStep[],
  stopOnFailure: boolean,
  session: MaloToolSession,
): Promise<MaloRunReport> {
  const startedAt = new Date();
  const results: MaloRunStepResult[] = [];
  let failedStep: number | null = null;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const started = Date.now();
    try {
      const invocation = await invokeMaloTool(step.type, step.args, session);
      results.push({
        index,
        type: step.type,
        ok: true,
        duration_ms: Date.now() - started,
        result: invocation.result,
      });
    } catch (error) {
      const demo = error instanceof DemoError ? error : null;
      results.push({
        index,
        type: step.type,
        ok: false,
        duration_ms: Date.now() - started,
        error: demo
          ? {
              code: demo.code,
              message: demo.message,
              details: {
                ...demo.details,
                ...(demo.screenshotPath ? { screenshotPath: demo.screenshotPath } : {}),
              },
            }
          : {
              code: "E_UNSUPPORTED",
              message: error instanceof Error ? error.message : String(error),
            },
      });
      if (failedStep === null) failedStep = index;
      if (stopOnFailure) break;
    }
  }
  const finishedAt = new Date();
  const report = {
    ok: failedStep === null,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    step_count: steps.length,
    failed_step: failedStep,
    steps: results,
  };
  const reportPath = await session.saveRunReport(report);
  return { ...report, report_path: reportPath };
}

function readOptionalInteger(
  args: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (args[field] === undefined) return undefined;
  return readInteger(args, field, min, min, max);
}
