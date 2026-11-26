import { afterEach, describe, expect, it, vi } from "vitest";
import { StageWindow } from "../../src/main/windows/stage-window";

type Bounds = { x: number; y: number; width: number; height: number };
type FakeToolbar = { page: unknown; view: { bounds: Bounds | null }; destroyed: boolean };

// vi.mock 的工厂在模块求值时执行，早于测试文件顶层语句，所以假实现放在 vi.hoisted 里
const fake = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    readonly contentView = {
      children: [] as unknown[],
      addChildView(view: unknown) {
        this.children.push(view);
      },
    };
    readonly handlers = new Map<string, () => void>();
    readonly positions: Array<[number, number]> = [];
    content: { width: number; height: number };
    position = { x: 200, y: 150 };
    shown = 0;
    shownInactive = 0;
    hidden = 0;
    destroyed = false;

    constructor(options: { width: number; height: number }) {
      this.content = { width: options.width, height: options.height };
      FakeWindow.instances.push(this);
    }

    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }

    getBounds(): Bounds {
      return { ...this.position, ...this.content };
    }

    getContentBounds() {
      return { ...this.content };
    }

    setPosition(x: number, y: number) {
      this.position = { x, y };
      this.positions.push([x, y]);
    }

    setContentSize(width: number, height: number) {
      this.content = { width, height };
      this.handlers.get("resize")?.();
    }

    show() {
      this.shown += 1;
    }

    showInactive() {
      this.shownInactive += 1;
    }

    hide() {
      this.hidden += 1;
    }

    isVisible() {
      return this.shown + this.shownInactive > this.hidden;
    }

    isDestroyed() {
      return this.destroyed;
    }

    setOpacity() {}

    setFullScreen() {}

    destroy() {
      this.destroyed = true;
      this.handlers.get("closed")?.();
    }

    close() {
      this.destroy();
    }
  }

  class FakeView {
    static instances: FakeView[] = [];
    bounds: Bounds | null = null;
    readonly webContents: FakePage = new FakePage();

    constructor() {
      FakeView.instances.push(this);
    }

    setBounds(bounds: Bounds) {
      this.bounds = bounds;
    }
  }

  class FakePage {
    destroyed = false;

    isDestroyed() {
      return this.destroyed;
    }

    close() {
      this.destroyed = true;
    }
  }

  const toolbars: FakeToolbar[] = [];  const workArea = { x: 0, y: 25, width: 1512, height: 900 };
  return { FakeWindow, FakeView, FakePage, toolbars, workArea };
});

vi.mock("electron", () => ({
  BaseWindow: fake.FakeWindow,
  WebContentsView: fake.FakeView,
  screen: {
    getPrimaryDisplay: () => ({ workArea: fake.workArea }),
    getAllDisplays: () => [],
  },
}));

vi.mock("../../src/main/windows/browser-toolbar", () => ({
  TOOLBAR_HEIGHT: 44,
  BrowserToolbar: class {
    readonly view = new fake.FakeView();
    destroyed = false;
    constructor(readonly page: unknown) {
      fake.toolbars.push(this);
    }
    layout() {}
    destroy() {
      this.destroyed = true;
    }
  },
}));

vi.mock("../../src/main/windows/dock-presence", () => ({
  dockPresenceShown: vi.fn(),
  dockPresenceHidden: vi.fn(),
}));

type FakeWindow = InstanceType<typeof fake.FakeWindow>;
type FakeView = InstanceType<typeof fake.FakeView>;
type FakePage = InstanceType<typeof fake.FakePage>;
const windowOf = (stage: StageWindow) => stage.window as unknown as FakeWindow;
const viewOf = (view: unknown) => view as unknown as FakeView;
const toolbarOf = (stage: StageWindow) => stage.toolbar as unknown as FakeToolbar;

const hiddenStage = (onWindowClosed?: () => void) =>
  new StageWindow({
    width: 900,
    height: 600,
    showMode: "hidden",
    toolbar: true,
    partition: "persist:test",
    onWindowClosed,
  });

const PAGE_AT = { x: 0, y: 44, width: 900, height: 600 };

afterEach(() => {
  fake.FakeWindow.instances = [];
  fake.FakeView.instances = [];
  fake.toolbars.length = 0;
  vi.clearAllMocks();
});

describe("StageWindow window lifecycle", () => {
  it("keeps a hidden session toolbar-free until it is first shown to a human", () => {
    const stage = hiddenStage();
    const window = windowOf(stage);

    expect(stage.toolbar).toBeNull();
    expect(window.contentView.children).toEqual([stage.view]);
    expect(viewOf(stage.view).bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 });

    stage.showForHuman("inactive");
    const toolbar = toolbarOf(stage);
    // 页面视口不变：长出来的是工具条，窗口内容区多出 44
    expect(window.getContentBounds()).toEqual({ width: 900, height: 644 });
    expect(viewOf(stage.view).bounds).toEqual(PAGE_AT);
    expect(window.contentView.children).toEqual([stage.view, toolbar.view]);
    expect(window.shownInactive).toBe(1);
    expect(window.shown).toBe(0);
  });

  it("centres a window once and leaves it where the human put it afterwards", () => {
    const stage = hiddenStage();
    const window = windowOf(stage);

    stage.showForHuman("inactive");
    expect(window.positions).toEqual([[306, 153]]);
    window.setPosition(50, 60);

    stage.showForHuman("inactive");
    stage.hide();
    stage.showForHuman("inactive");

    expect(window.positions).toEqual([
      [306, 153],
      [50, 60],
    ]);
  });

  it("re-hosts the same page view in a fresh hidden window after the human closes it", () => {
    const onWindowClosed = vi.fn();
    const stage = hiddenStage(onWindowClosed);
    const first = windowOf(stage);
    stage.showForHuman("inactive");
    const toolbar = toolbarOf(stage);
    const page = stage.view;

    first.close();

    expect(onWindowClosed).toHaveBeenCalledOnce();
    const second = windowOf(stage);
    expect(second).not.toBe(first);
    expect(second.isDestroyed()).toBe(false);
    expect(stage.isVisible()).toBe(false);
    // 同一个页面视图和工具条被挂到新窗口上，页面视口原样保留
    expect(stage.view).toBe(page);
    expect(second.contentView.children).toEqual([page, toolbar.view]);
    expect(viewOf(page).bounds).toEqual(PAGE_AT);

    stage.showForHuman("inactive");
    expect(second.positions).toEqual([[306, 153]]);
    expect(second.shownInactive).toBe(1);
    expect(toolbarOf(stage)).toBe(toolbar);
  });

  it("leaves the window destroyed when the owner did not ask to survive a close", () => {
    const stage = hiddenStage();
    const window = windowOf(stage);

    window.close();

    expect(windowOf(stage)).toBe(window);
    expect(window.isDestroyed()).toBe(true);
    expect(fake.FakeWindow.instances).toHaveLength(1);
  });

  it("does not re-create the window when the stage itself is closed", () => {
    const onWindowClosed = vi.fn();
    const stage = hiddenStage(onWindowClosed);
    stage.showForHuman("inactive");
    const window = windowOf(stage);
    const toolbar = toolbarOf(stage);

    stage.close();
    stage.close();

    expect(onWindowClosed).not.toHaveBeenCalled();
    expect(window.isDestroyed()).toBe(true);
    expect(fake.FakeWindow.instances).toHaveLength(1);
    expect(toolbar.destroyed).toBe(true);
    expect(stage.toolbar).toBeNull();
  });

  it("gives a stage that starts visible its toolbar right away", () => {
    const stage = new StageWindow({ width: 900, height: 600, showMode: "inactive", toolbar: true });
    const window = windowOf(stage);
    expect(stage.toolbar).not.toBeNull();
    expect(window.getContentBounds()).toEqual({ width: 900, height: 644 });
    expect(window.shownInactive).toBe(1);
  });

  it("destroys the page with the stage so its renderer does not outlive the session", () => {
    const stage = hiddenStage();
    const page = viewOf(stage.view).webContents as FakePage;

    stage.close();

    expect(page.destroyed).toBe(true);
  });

  it("does not re-host a page that was destroyed underneath the window", () => {
    const onWindowClosed = vi.fn();
    const stage = hiddenStage(onWindowClosed);
    stage.showForHuman("inactive");
    const window = windowOf(stage);
    const page = viewOf(stage.view).webContents as FakePage;

    page.close();
    window.close();

    expect(onWindowClosed).not.toHaveBeenCalled();
    expect(fake.FakeWindow.instances).toHaveLength(1);
    expect(window.isDestroyed()).toBe(true);
    expect(() => stage.showForHuman("inactive")).toThrow("页面已销毁");
  });

  it("closing a stage whose page is already gone stays a no-op for the page", () => {
    const stage = hiddenStage();
    const page = viewOf(stage.view).webContents as FakePage;
    page.close();

    expect(() => stage.close()).not.toThrow();
    expect(windowOf(stage).isDestroyed()).toBe(true);
  });
});
