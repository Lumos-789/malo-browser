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
    isDestroyed: () => false,
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

describe("ElectronPageDriver drag", () => {
  it("runs move → press → interpolated moves with the button held → release", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);

    await driver.drag({ x: 100, y: 50 }, { x: 200, y: 50 }, 4);

    const calls = wc.debugger.sendCommand.mock.calls
      .filter(([method]) => method === "Input.dispatchMouseEvent")
      .map(([, params]) => params as Record<string, number | string>);
    const types = calls.map((params) => params.type);
    expect(types[0]).toBe("mouseMoved");
    expect(types[1]).toBe("mousePressed");
    expect(types.slice(2, -1)).toEqual(Array.from({ length: 4 }, () => "mouseMoved"));
    expect(types[types.length - 1]).toBe("mouseReleased");

    expect(calls[1]).toMatchObject({ x: 100, y: 50, button: "left", buttons: 1, clickCount: 1 });
    expect(calls[2]).toMatchObject({ x: 125, y: 50, button: "left", buttons: 1 });
    expect(calls[calls.length - 2]).toMatchObject({ x: 200, y: 50, buttons: 1 });
    expect(calls[calls.length - 1]).toMatchObject({ x: 200, y: 50, button: "left", buttons: 0, clickCount: 1 });
  });
});

describe("ElectronPageDriver detach", () => {
  it("页面已被销毁时直接返回，不再去碰调试器", () => {
    const wc = { ...fakeContents(), isDestroyed: () => true };
    const driver = new ElectronPageDriver(wc as never);

    expect(() => driver.detach()).not.toThrow();
    expect(wc.debugger.off).not.toHaveBeenCalled();
    expect(wc.debugger.detach).not.toHaveBeenCalled();
  });
});

describe("ElectronPageDriver key events", () => {
  const keyEvents = (wc: ReturnType<typeof fakeContents>) =>
    wc.debugger.sendCommand.mock.calls
      .filter(([method]) => method === "Input.dispatchKeyEvent")
      .map(([, params]) => params as Record<string, unknown>);

  it("sends named keys with the virtual key codes that pages listen for", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);

    await driver.press("ArrowDown");

    const events = keyEvents(wc);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "rawKeyDown",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40,
      modifiers: 0,
    });
    expect(events[0].text).toBeUndefined();
    expect(events[1]).toMatchObject({ type: "keyUp", key: "ArrowDown", windowsVirtualKeyCode: 40 });
  });

  it("sends printable keys as keyDown with text, honouring Shift", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);

    await driver.press("Enter");
    await driver.press("a", 8);
    await driver.press("a", 2);

    const events = keyEvents(wc);
    expect(events[0]).toMatchObject({ type: "keyDown", key: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    expect(events[2]).toMatchObject({ type: "keyDown", key: "a", code: "KeyA", text: "A", modifiers: 8 });
    // 按着 Ctrl 时不输入字符，只发按键
    expect(events[4]).toMatchObject({ type: "rawKeyDown", key: "a", modifiers: 2 });
    expect(events[4].text).toBeUndefined();
  });

  it("types one key event per character and sends Enter for a newline", async () => {
    const wc = fakeContents();
    const driver = new ElectronPageDriver(wc as never);

    await driver.typeText("a中\r\nb", 0);

    const typed = keyEvents(wc).filter((event) => event.type !== "keyUp");
    expect(typed.map((event) => [event.key, event.text])).toEqual([
      ["a", "a"],
      ["中", "中"],
      ["Enter", "\r"],
      ["b", "b"],
    ]);
  });
});

describe("ElectronPageDriver scroll", () => {
  it("lands the wheel at the viewport center unless told otherwise", async () => {
    const wc = fakeContents();
    wc.debugger.sendCommand.mockImplementation(async (method: string, params?: { expression?: string }) =>
      method === "Runtime.evaluate"
        ? { result: { value: params?.expression?.includes("scrollX") ? "0,0" : { x: 640, y: 360 } } }
        : {},
    );
    const driver = new ElectronPageDriver(wc as never);
    const wheels = () =>
      wc.debugger.sendCommand.mock.calls
        .filter(([method]) => method === "Input.dispatchMouseEvent")
        .map(([, params]) => params as Record<string, number>);

    await driver.scroll({ x: 0, y: 100 });
    await driver.scroll({ x: 0, y: 100 }, { x: 30, y: 40 });

    expect(wheels()).toEqual([
      { type: "mouseWheel", x: 640, y: 360, deltaX: 0, deltaY: 100 },
      { type: "mouseWheel", x: 30, y: 40, deltaX: 0, deltaY: 100 },
    ]);
  });
});

describe("ElectronPageDriver scroll settling", () => {
  it("waits until the scroll position stops moving before returning", async () => {
    const wc = fakeContents();
    let wheelSent = 0;
    const reads: string[] = [];
    wc.debugger.sendCommand.mockImplementation(async (method: string, params?: { expression?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseWheel") wheelSent += 1;
      if (method !== "Runtime.evaluate") return {};
      if (!params?.expression?.includes("scrollX")) return { result: { value: { x: 640, y: 360 } } };
      reads.push("read");
      // 发出滚轮后的前几次读取位置还在变，之后稳定在 400
      const value = wheelSent === 0 ? "0,0" : reads.length < 4 ? `0,${reads.length * 100}` : "0,400";
      return { result: { value } };
    });
    const driver = new ElectronPageDriver(wc as never);

    await driver.scroll({ x: 0, y: 400 });

    // 位置变过之后要连续两拍不变才返回：至少读到「400」两次
    expect(wheelSent).toBe(1);
    expect(reads.length).toBeGreaterThanOrEqual(5);
  });

  it("gives up waiting when nothing scrolls", async () => {
    const wc = fakeContents();
    let wheelSent = 0;
    let reads = 0;
    wc.debugger.sendCommand.mockImplementation(async (method: string, params?: { expression?: string }) => {
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseWheel") wheelSent += 1;
      if (method !== "Runtime.evaluate") return {};
      if (!params?.expression?.includes("scrollX")) return { result: { value: { x: 640, y: 360 } } };
      reads += 1;
      return { result: { value: "0,0" } };
    });
    const driver = new ElectronPageDriver(wc as never);

    await driver.scroll({ x: 0, y: 400 });

    // 已经滚到底：位置一直不变，多等几拍（约 160ms）就放手，不会卡满 600ms
    expect(wheelSent).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(4);
    expect(reads).toBeLessThan(10);
  });
});
