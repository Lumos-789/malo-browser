/**
 * 人在 watch 窗口的工具条上能给 agent 发的信号：做完了吗、要不要先停手、是不是到此为止。
 * 纯状态机：会话核心负责记事件和同步面板，这里只决定状态怎么变。
 */
export type HumanSignal = "done" | "pause" | "resume" | "stop";

export type HumanState = {
  /** 人点了「完成」，等着它的那一步可以走了；被取走后清零，下一轮交接还能再点。 */
  done: boolean;
  paused: boolean;
  /** 终态：人点了「停止」，之后不再接受任何信号。 */
  stopped: boolean;
};

export type AgentBlock = "E_PAUSED_BY_HUMAN" | "E_STOPPED_BY_HUMAN";

export const HUMAN_BLOCK_MESSAGES: Record<AgentBlock, string> = {
  E_PAUSED_BY_HUMAN:
    "人已在面板上点了「暂停」：等人在窗口里点「继续」后再操作页面（观察、截图、读取类工具不受影响）",
  E_STOPPED_BY_HUMAN:
    "人已在面板上点了「停止」：这个会话不能再操作页面，请收尾并关闭会话（观察类工具仍可用）",
};

export function initialHumanState(): HumanState {
  return { done: false, paused: false, stopped: false };
}

/** 返回新状态与要记的事件；信号没有带来变化时事件为 null。 */
export function applyHumanSignal(
  state: HumanState,
  signal: HumanSignal,
): { state: HumanState; event: string | null } {
  if (state.stopped) return { state, event: null };
  switch (signal) {
    case "done":
      return state.done ? { state, event: null } : { state: { ...state, done: true }, event: "human.done" };
    case "pause":
      return state.paused ? { state, event: null } : { state: { ...state, paused: true }, event: "human.paused" };
    case "resume":
      return state.paused ? { state: { ...state, paused: false }, event: "human.resumed" } : { state, event: null };
    case "stop":
      return { state: { done: false, paused: false, stopped: true }, event: "human.stopped" };
  }
}

/** 取走「完成」信号：等它的那一步拿到后清掉。 */
export function consumeHumanDone(state: HumanState): { done: boolean; state: HumanState } {
  if (!state.done) return { done: false, state };
  return { done: true, state: { ...state, done: false } };
}

/** agent 要动页面之前查一下：人喊了停就不能动。 */
export function humanBlock(state: HumanState): AgentBlock | null {
  if (state.stopped) return "E_STOPPED_BY_HUMAN";
  if (state.paused) return "E_PAUSED_BY_HUMAN";
  return null;
}
