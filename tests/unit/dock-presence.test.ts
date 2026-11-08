import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseWindow } from "electron";

const { dockShow, dockHide, activateHandlers } = vi.hoisted(() => ({
  dockShow: vi.fn(() => Promise.resolve()),
  dockHide: vi.fn(() => undefined),
  activateHandlers: [] as Array<() => void>,
}));

vi.mock("electron", () => ({
  app: {
    dock: { show: () => dockShow(), hide: () => dockHide() },
    on: (event: string, handler: () => void) => {
      if (event === "activate") activateHandlers.push(handler);
    },
  },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
  BaseWindow: class FakeBaseWindow {
    readonly listeners = new Map<string, () => void>();
    readonly contentView = { addChildView: () => undefined };
    show = vi.fn();
    showInactive = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    setOpacity = vi.fn();
    setPosition = vi.fn();
    setFullScreen = vi.fn();
    isVisible = () => true;
    isDestroyed = () => false;
    getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
    getContentBounds = () => ({ x: 0, y: 0, width: 800, height: 600 });
    destroy = vi.fn();
    on(event: string, handler: () => void) {
      this.listeners.set(`on:${event}`, handler);
    }
    once(event: string, handler: () => void) {
      this.listeners.set(`once:${event}`, handler);
    }
    emit(event: string) {
      this.listeners.get(`on:${event}`)?.();
      this.listeners.get(`once:${event}`)?.();
    }
  },
  WebContentsView: class FakeWebContentsView {
    readonly webContents = {} as never;
    setBounds = vi.fn();
  },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

type Modules = {
  initDockPresence: (options: { dynamic: boolean }) => void;
  dockPresenceShown: (window: BaseWindow) => void;
  dockPresenceHidden: (window: BaseWindow) => void;
  StageWindow: new (options: {
    width: number;
    height: number;
    showMode: "hidden" | "inactive" | "focused" | "offscreen" | "ghost";
  }) => {
    window: BaseWindow & { showInactive: ReturnType<typeof vi.fn> };
    show(mode: "inactive" | "focused" | "offscreen" | "ghost"): void;
    showForHuman(mode: "inactive" | "focused"): void;
    hide(): void;
    close(): void;
  };
};

let modules: Modules;

beforeEach(async () => {
  vi.clearAllMocks();
  activateHandlers.length = 0;
  vi.resetModules();
  modules = (await import("../../src/main/windows/dock-presence")) as unknown as Modules;
  modules.StageWindow = (await import("../../src/main/windows/stage-window")).StageWindow;
});

function makeFakeWindow(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, () => void>();
  const window = {
    isDestroyed: () => false,
    focus: vi.fn(),
    once: (event: string, handler: () => void) => listeners.set(event, handler),
    fireClosed: () => listeners.get("closed")?.(),
    ...overrides,
  };
  return window as typeof window & BaseWindow;
}

describe("dock presence", () => {
  it("shows the Dock icon while any window is human-visible and hides it once none is left", () => {
    modules.initDockPresence({ dynamic: true });
    const first = makeFakeWindow();
    const second = makeFakeWindow();

    modules.dockPresenceShown(first);
    expect(dockShow).toHaveBeenCalledTimes(1);
    expect(dockHide).not.toHaveBeenCalled();

    modules.dockPresenceShown(first);
    modules.dockPresenceShown(second);
    expect(dockShow).toHaveBeenCalledTimes(1);

    modules.dockPresenceHidden(first);
    expect(dockHide).not.toHaveBeenCalled();

    modules.dockPresenceHidden(second);
    expect(dockHide).toHaveBeenCalledTimes(1);
    expect(dockShow).toHaveBeenCalledTimes(1);
  });

  it("releases the Dock icon when the window closes", () => {
    modules.initDockPresence({ dynamic: true });
    const window = makeFakeWindow();

    modules.dockPresenceShown(window);
    expect(dockShow).toHaveBeenCalledTimes(1);

    window.fireClosed();
    expect(dockHide).toHaveBeenCalledTimes(1);
  });

  it("does nothing when dynamic mode is off", () => {
    modules.initDockPresence({ dynamic: false });
    modules.dockPresenceShown(makeFakeWindow());
    modules.dockPresenceHidden(makeFakeWindow());
    expect(dockShow).not.toHaveBeenCalled();
    expect(dockHide).not.toHaveBeenCalled();
    expect(activateHandlers).toHaveLength(0);
  });

  it("focuses visible windows when the user clicks the Dock icon", () => {
    modules.initDockPresence({ dynamic: true });
    const first = makeFakeWindow();
    const second = makeFakeWindow();
    const destroyed = makeFakeWindow({ isDestroyed: () => true, focus: vi.fn() });

    modules.dockPresenceShown(first);
    modules.dockPresenceShown(second);
    modules.dockPresenceShown(destroyed);
    expect(activateHandlers).toHaveLength(1);

    activateHandlers[0]!();
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(second.focus).toHaveBeenCalledTimes(1);
    expect(destroyed.focus).not.toHaveBeenCalled();
  });
});

describe("StageWindow dock wiring", () => {
  it("surfaces the Dock icon for human-visible windows and drops it on hide/close", () => {
    modules.initDockPresence({ dynamic: true });
    const stage = new modules.StageWindow({ width: 640, height: 480, showMode: "hidden" });
    expect(dockShow).not.toHaveBeenCalled();

    stage.show("inactive");
    expect(stage.window.showInactive).toHaveBeenCalledTimes(1);
    expect(dockShow).toHaveBeenCalledTimes(1);

    stage.hide();
    expect(dockHide).toHaveBeenCalledTimes(1);

    stage.showForHuman("focused");
    expect(dockShow).toHaveBeenCalledTimes(2);

    stage.close();
    expect(dockHide).toHaveBeenCalledTimes(2);
  });

  it("keeps offscreen and ghost windows off the Dock", () => {
    modules.initDockPresence({ dynamic: true });
    const stage = new modules.StageWindow({ width: 640, height: 480, showMode: "hidden" });

    stage.show("offscreen");
    expect(dockShow).not.toHaveBeenCalled();

    stage.show("ghost");
    expect(dockShow).not.toHaveBeenCalled();
    expect(dockHide).not.toHaveBeenCalled();
  });
});
