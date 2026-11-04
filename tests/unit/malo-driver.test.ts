import { describe, expect, it, vi } from "vitest";
import { DemoError } from "../../src/shared/errors";
import { ElectronPageDriver } from "../../src/main/electron-page-driver";

function fakeContents() {
  const sendCommand = vi.fn(async () => ({}));
  return {
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand,
      on: vi.fn(),
      off: vi.fn(),
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
