import { DemoError, stripErrorCode } from "../../../shared/errors";
import type { MaloAction, MaloActionResult } from "../../../shared/malo";
import { observePage } from "../observation";
import { mainContext, resolveContext, type FrameRef } from "../frames";
import type { SessionInternals } from "../session-internals";
import { fill, focus, press, select, type, uploadFile } from "./input";
import { click, drag, hover, scroll, scrollIntoView } from "./pointer";
import { history, sleepAction, waitFor } from "./wait";

type ActionName = MaloAction["type"];
type ActionOf<K extends ActionName> = Extract<MaloAction, { type: K }>;
/** 每个动作拿到会话（发输入事件、记事件）和解析好的页面上下文（顶层页面或某个 iframe）。 */
export type ActionHandler<K extends ActionName> = (
  session: SessionInternals,
  ctx: Awaited<ReturnType<typeof resolveContext>>,
  action: ActionOf<K>,
  timeoutMs: number,
) => Promise<string>;

// 能在 iframe 里执行的动作；其余动作（键盘、拖拽、历史、休眠）作用于整个页面，不接受 frame
const FRAMED_ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>([
  "click",
  "fill",
  "hover",
  "select",
  "focus",
  "scroll",
  "scroll_into_view",
  "wait_for",
  "upload_file",
]);

const HANDLERS: { [K in ActionName]: ActionHandler<K> } = {
  click,
  fill,
  drag,
  upload_file: uploadFile,
  press,
  type,
  scroll,
  hover,
  select,
  focus,
  scroll_into_view: scrollIntoView,
  history,
  wait_for: waitFor,
  sleep: sleepAction,
};

function readFrameRef(action: MaloAction, allowed: boolean): FrameRef {
  const ref = action as { frame?: unknown; frame_url?: unknown };
  if (ref.frame === undefined && ref.frame_url === undefined) return {};
  if (!allowed) {
    throw new DemoError(
      "E_BAD_REQUEST",
      `${action.type} 作用于整个页面，不接受 frame 参数（键盘输入会落到当前聚焦的元素上，拖拽请用顶层坐标）`,
    );
  }
  if (ref.frame_url !== undefined && typeof ref.frame_url !== "string") {
    throw new DemoError("E_BAD_REQUEST", "frame_url 必须是字符串");
  }
  return { frame: ref.frame as number | undefined, frame_url: ref.frame_url as string | undefined };
}

export async function executeAction(
  session: SessionInternals,
  action: MaloAction,
  timeoutMs: number,
): Promise<string> {
  const name = action.type as ActionName;
  const handler = (HANDLERS as Record<string, ActionHandler<ActionName> | undefined>)[name];
  if (!handler) {
    throw new DemoError("E_UNSUPPORTED", `未知动作：${String((action as { type?: unknown }).type ?? "")}`);
  }
  const ref = readFrameRef(action, FRAMED_ACTIONS.has(name));
  if (name === "wait_for" && (action as { human?: unknown }).human === true) {
    if (ref.frame !== undefined || ref.frame_url !== undefined) {
      throw new DemoError("E_BAD_REQUEST", "wait_for human 不接受 frame 参数");
    }
    return handler(session, mainContext(session), action, timeoutMs);
  }
  const ctx = await resolveContext(session, ref);
  return handler(session, ctx, action, timeoutMs);
}

export async function runAction(
  session: SessionInternals,
  action: MaloAction,
  timeoutMs: number,
): Promise<MaloActionResult> {
  session.assertOpen();
  session.touch();
  const boundedTimeout = Math.max(100, Math.min(120_000, Math.floor(timeoutMs)));
  session.record("action.started", { action: action.type });
  const popupBefore = session.popupSeq;
  try {
    const detail = await executeAction(session, action, boundedTimeout);
    const observation = await observePage(session, "light", 2_000);
    session.record("action.completed", { action: action.type, detail });
    // 这个动作触发了 window.open：把目标地址带回给 agent（被拦下，或 adopt 模式下已在当前页面打开）
    const popup = session.popupSeq === popupBefore ? {} : { popup: session.lastPopup ?? undefined };
    return { action: action.type, detail, observation, ...popup };
  } catch (error) {
    const screenshotPath = await session.captureFailure();
    const message = error instanceof Error ? error.message : String(error);
    session.record("action.failed", { action: action.type, message, screenshotPath });
    if (error instanceof DemoError) {
      throw new DemoError(error.code, stripErrorCode(error.code, message), {
        ...error.toDetail(),
        screenshotPath: screenshotPath ?? error.screenshotPath,
      });
    }
    throw new DemoError("E_UNSUPPORTED", message, { screenshotPath: screenshotPath ?? undefined });
  }
}
