import { describe, expect, it, vi } from "vitest";
import { DemoError } from "../../src/shared/errors";
import { ElectronPageDriver } from "../../src/main/electron-page-driver";

function fakeContents() {
  const sendCommand = vi.fn(async () => ({}));
  const messageHandlers: Array<
    (event: unknown, method: string, params: Record<string, unknown>) => void
  > = [];
  return {
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand,
      on: vi.fn((event: string, handler: (typeof messageHandlers)[number]) => {
        if (event === "message") messageHandlers.push(handler);
      }),
      off: vi.fn((event: string, handler: (typeof messageHandlers)[number]) => {
        if (event !== "message") return;
        const index = messageHandlers.indexOf(handler);
        if (index >= 0) messageHandlers.splice(index, 1);
      }),
    },
    emitDebuggerMessage(method: string, params: Record<string, unknown>) {
      for (const handler of messageHandlers) handler({}, method, params);
    },
    selectAll: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    cut: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    getURL: () => "http://127.0.0.1/",
    isLoading: () => false,
    loadURL: vi.fn(async () => undefined),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    session: {},
  };
}

describe("ElectronPageDriver meta shortcuts", () => {
  it("maps command shortcuts to WebContents editing commands", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);

    await driver.press("a", 4);
    await driver.press("c", 4);
    await driver.press("v", 4);
    await driver.press("x", 4);
    await driver.press("z", 4);
    await driver.press("z", 4 | 8);

    expect(wc.selectAll).toHaveBeenCalledOnce();
    expect(wc.copy).toHaveBeenCalledOnce();
    expect(wc.paste).toHaveBeenCalledOnce();
    expect(wc.cut).toHaveBeenCalledOnce();
    expect(wc.undo).toHaveBeenCalledOnce();
    expect(wc.redo).toHaveBeenCalledOnce();
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("rejects unsupported command chords instead of opening the app menu", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);
    await expect(driver.press("q", 4)).rejects.toMatchObject({ code: "E_UNSUPPORTED" });
    await expect(driver.press("q", 4)).rejects.toBeInstanceOf(DemoError);
    expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it("still dispatches ordinary keys through CDP", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);
    await driver.press("Enter");
    expect(wc.debugger.sendCommand).toHaveBeenCalledTimes(2);
    expect(wc.debugger.sendCommand.mock.calls[0][0]).toBe("Input.dispatchKeyEvent");
  });
});

describe("ElectronPageDriver CDP event registry", () => {
  it("routes events by method and keeps the lifecycle tracker", () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);
    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = driver.onCdpEvent("Network.responseReceived", (params) => {
      seen.push(params);
    });

    const params = {
      requestId: "request-1",
      response: { url: "http://127.0.0.1/api", status: 200 },
    };
    wc.emitDebuggerMessage("Network.responseReceived", params);
    expect(seen).toEqual([params]);

    wc.emitDebuggerMessage("Page.lifecycleEvent", { name: "networkAlmostIdle" });
    expect(driver.lastLifecycleAt("networkAlmostIdle")).toBeTypeOf("number");
    expect(seen).toHaveLength(1);

    unsubscribe();
    wc.emitDebuggerMessage("Network.responseReceived", params);
    expect(seen).toHaveLength(1);
  });

  it("does not deliver an event to handlers of another method", () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);
    const seen: string[] = [];
    driver.onCdpEvent("Network.loadingFinished", (params) => {
      seen.push(String(params.requestId));
    });

    wc.emitDebuggerMessage("Network.responseReceived", { requestId: "a" });
    expect(seen).toEqual([]);
    wc.emitDebuggerMessage("Network.loadingFinished", { requestId: "b" });
    expect(seen).toEqual(["b"]);
  });
});

describe("ElectronPageDriver evaluate error mapping", () => {
  it("maps a selector SyntaxError to a bad request instead of a step timeout", async () => {
    const wc = fakeContents();
    wc.debugger.sendCommand.mockResolvedValueOnce({
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          description: "SyntaxError: Failed to execute 'querySelector' on 'Document'",
          className: "SyntaxError",
        },
      },
    });
    const driver = new ElectronPageDriver(wc as never);

    await expect(driver.evaluate("document.querySelector('##bad')")).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
  });

  it("keeps a genuine page error as a step timeout", async () => {
    const wc = fakeContents();
    wc.debugger.sendCommand.mockResolvedValueOnce({
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught",
        exception: { description: "TypeError: boom", className: "TypeError" },
      },
    });
    const driver = new ElectronPageDriver(wc as never);

    await expect(driver.evaluate("boom()")).rejects.toMatchObject({ code: "E_STEP_TIMEOUT" });
  });

  it("also maps a parse error reported only in exceptionDetails.text", async () => {
    const wc = fakeContents();
    wc.debugger.sendCommand.mockResolvedValueOnce({
      result: { value: undefined },
      exceptionDetails: {
        text: "Uncaught SyntaxError: Failed to execute 'querySelector' on 'Document'",
      },
    });
    const driver = new ElectronPageDriver(wc as never);

    await expect(driver.evaluate("document.querySelector('##bad')")).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
  });
});
