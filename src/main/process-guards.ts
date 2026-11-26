type EventSource = {
  on(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): unknown;
};

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/**
 * 未捕获异常的处置因模式而异：录制、跑场景是一次性进程，出错直接退出；
 * daemon 里一个会话的意外不能带走所有 agent 的会话——记下完整栈继续跑。
 */
export function installProcessGuards(
  source: EventSource,
  mode: () => string | null,
  fatal: (error: unknown) => void,
): void {
  const handle = (kind: string, error: unknown) => {
    if (mode() === "daemon") {
      console.error(`[malo-browser] ${kind}（daemon 继续运行）：${describe(error)}`);
      return;
    }
    fatal(error);
  };
  source.on("uncaughtException", (error) => handle("未捕获异常", error));
  source.on("unhandledRejection", (error) => handle("未处理的 Promise 拒绝", error));
}
