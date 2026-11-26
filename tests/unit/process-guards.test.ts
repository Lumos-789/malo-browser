import { describe, expect, it, vi } from "vitest";
import { installProcessGuards } from "../../src/main/process-guards";

function harness(mode: () => string | null) {
  const listeners = new Map<string, (error: unknown) => void>();
  const fatal = vi.fn();
  installProcessGuards(
    {
      on(event, listener) {
        listeners.set(event, listener);
      },
    },
    mode,
    fatal,
  );
  return {
    fatal,
    emit(event: "uncaughtException" | "unhandledRejection", error: unknown) {
      listeners.get(event)?.(error);
    },
  };
}

describe("process guards", () => {
  it("daemon 模式下未捕获异常只记录，不带走所有 agent 的会话", () => {
    const error = new Error("one session blew up");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((message) => {
      logs.push(String(message));
    });
    try {
      const guards = harness(() => "daemon");
      guards.emit("uncaughtException", error);
      guards.emit("unhandledRejection", "a rejected promise");
      expect(guards.fatal).not.toHaveBeenCalled();
      expect(logs).toHaveLength(2);
      expect(logs[0]).toContain("daemon 继续运行");
      expect(logs[0]).toContain("one session blew up");
      expect(logs[1]).toContain("未处理的 Promise 拒绝");
      expect(logs[1]).toContain("a rejected promise");
    } finally {
      spy.mockRestore();
    }
  });

  it("一次性进程（录制、跑场景、启动失败）里未捕获异常照旧致命", () => {
    for (const mode of ["record", "app", "stage", null]) {
      const error = new Error("boom");
      const guards = harness(() => mode);
      guards.emit("uncaughtException", error);
      guards.emit("unhandledRejection", error);
      expect(guards.fatal).toHaveBeenCalledTimes(2);
      expect(guards.fatal).toHaveBeenCalledWith(error);
    }
  });
});
