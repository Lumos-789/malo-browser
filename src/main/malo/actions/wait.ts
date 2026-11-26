import { DemoError } from "../../../shared/errors";
import { sleep } from "../../tools";
import type { PageContext } from "../frames";
import type { SessionInternals } from "../session-internals";
import type { ActionHandler } from "./run-action";

/** 每 100ms 在目标页面上下文里求值一次，直到为真或超时。 */
async function waitUntil(
  ctx: PageContext,
  expression: string,
  timeoutMs: number,
  describe: () => DemoError,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ctx.evaluate<boolean>(expression)) return;
    await sleep(100);
  }
  throw describe();
}

export const waitFor: ActionHandler<"wait_for"> = async (session, ctx, action, timeoutMs) => {
  if (action.timeout_ms !== undefined && (!Number.isFinite(action.timeout_ms) || action.timeout_ms < 0)) {
    throw new DemoError("E_UNSUPPORTED", "wait_for.timeout_ms 必须是非负数字");
  }
  const limit = action.timeout_ms ?? timeoutMs;
  if (action.human === true) {
    await session.waitHumanDone(limit);
    return "human signaled done";
  }
  const where = ctx.frame ? `（第 ${ctx.frame.index} 个 iframe）` : "";
  if (action.frame !== undefined) throw new DemoError("E_BAD_REQUEST", "wait_for human 不接受 frame 参数");
  if (action.selector) {
    const state = action.state ?? "visible";
    if (state !== "attached" && state !== "visible" && state !== "hidden") {
      throw new DemoError("E_UNSUPPORTED", "wait_for.state 只能是 attached / visible / hidden");
    }
    await waitUntil(
      ctx,
      `(() => {
        const el = document.querySelector(${JSON.stringify(action.selector)});
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        return ${JSON.stringify(state)} === "attached" ? true : ${JSON.stringify(state)} === "visible" ? visible : !visible;
      })()`,
      limit,
      () => new DemoError("E_STEP_TIMEOUT", `${limit}ms 内元素未达到 ${state}：${action.selector}${where}`, {
        selector: action.selector,
        url: ctx.frame ? ctx.frame.url : undefined,
      }),
    );
    return `selector ${state}: ${action.selector}`;
  }
  if (action.human !== undefined && typeof action.human !== "boolean") {
    throw new DemoError("E_BAD_REQUEST", "wait_for.human 必须是布尔值");
  }
  if (action.text) {
    await waitUntil(
      ctx,
      `document.body && document.body.innerText.includes(${JSON.stringify(action.text)})`,
      limit,
      () => new DemoError("E_STEP_TIMEOUT", `${limit}ms 内页面未出现文本「${action.text}」${where}`),
    );
    return `text appeared: ${action.text}`;
  }
  throw new DemoError("E_UNSUPPORTED", "wait_for 需要 selector 或 text");
};

export const sleepAction: ActionHandler<"sleep"> = async (_session, _ctx, action) => {
  if (!Number.isFinite(action.ms) || action.ms < 0 || action.ms > 120_000) {
    throw new DemoError("E_UNSUPPORTED", "sleep.ms 必须是 0-120000 的毫秒数");
  }
  await sleep(action.ms);
  return `slept ${action.ms}ms`;
};

export const history: ActionHandler<"history"> = async (session, _ctx, action) => {
  if (action.action !== "back" && action.action !== "forward" && action.action !== "reload") {
    throw new DemoError("E_UNSUPPORTED", "history.action 只能是 back / forward / reload");
  }
  const history = session.stage.view.webContents.navigationHistory;
  if (action.action === "back") history.goBack();
  else if (action.action === "forward") history.goForward();
  else session.stage.view.webContents.reload();
  await sleep(300);
  return `history ${action.action}`;
};
