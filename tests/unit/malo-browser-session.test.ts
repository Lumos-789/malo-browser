import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSession,
  type BrowserSessionOptions,
} from "../../src/main/malo/browser-session";

// vi.mock 的工厂在模块求值时执行，早于测试文件顶层语句，所以假实现放在 vi.hoisted 里
const fake = vi.hoisted(() => {
  function fakeWebContents() {
    const handlers = new Map<string, () => void>();
    return {
      destroyed: false,
      session: {
        setPermissionRequestHandler() {},
        on() {},
        async clearStorageData() {},
        async clearCache() {},
        webRequest: { onErrorOccurred() {}, onCompleted() {} },
      },
      setWindowOpenHandler() {},
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      emit(event: string) {
        handlers.get(event)?.();
      },
      isDestroyed() {
        return this.destroyed;
      },
      async loadURL() {},
      getURL: () => "about:blank",
      getTitle: () => "",
      isLoading: () => false,
    };
  }

  class FakeStage {
    static instances: FakeStage[] = [];
    visible = false;
    closed = false;
    readonly view = { webContents: fakeWebContents() };
    constructor(readonly options: { onWindowClosed?: () => void }) {
      FakeStage.instances.push(this);
    }
    showForHuman() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    resize() {}
    isVisible() {
      return this.visible;
    }
    close() {
      this.closed = true;
      this.visible = false;
      this.view.webContents.destroyed = true;
      this.view.webContents.emit("destroyed");
    }
    humanClose() {
      this.visible = false;
      this.options.onWindowClosed?.();
    }
    /** 页面在会话之外被销毁（例如经 CDP 调试口关掉页面目标） */
    losePage() {
      this.view.webContents.destroyed = true;
      this.view.webContents.emit("destroyed");
    }
  }

  class FakeDriver {
    static instances: FakeDriver[] = [];
    evaluate = vi.fn(async () => null);
    attach = vi.fn(async () => undefined);
    detach = vi.fn();
    send = vi.fn(async () => ({}));
    onCdpEvent = vi.fn(() => () => undefined);
    lastLifecycleAt = vi.fn(() => undefined);
    constructor() {
      FakeDriver.instances.push(this);
    }
  }

  return { FakeStage, FakeDriver };
});

vi.mock("../../src/main/windows/stage-window", () => ({ StageWindow: fake.FakeStage }));
vi.mock("../../src/main/electron-page-driver", () => ({ ElectronPageDriver: fake.FakeDriver }));

type FakeStage = InstanceType<typeof fake.FakeStage>;
type FakeDriver = InstanceType<typeof fake.FakeDriver>;
const stageOf = (session: BrowserSession) =>
  fake.FakeStage.instances[fake.FakeStage.instances.length - 1] as FakeStage;
const driverOf = () => fake.FakeDriver.instances[fake.FakeDriver.instances.length - 1] as FakeDriver;

const ASSERT_STATE = {
  url: "about:blank",
  title: "",
  visible: false,
  hidden_visible: null,
  text: null,
  value: null,
  value_redacted: false,
  count: null,
  invalid_selector: null,
};

const tmpDirs: string[] = [];

async function newSession(extra: Partial<BrowserSessionOptions> = {}): Promise<BrowserSession> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "malo-browser-session-"));
  tmpDirs.push(rootDir);
  const session = await BrowserSession.create({ leaseId: "lease-test", name: "s", rootDir, ...extra });
  driverOf().evaluate.mockResolvedValue(ASSERT_STATE);
  return session;
}

afterEach(async () => {
  fake.FakeStage.instances = [];
  fake.FakeDriver.instances = [];
  vi.clearAllMocks();
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("BrowserSession 进行中保护", () => {
  it("有操作在进行、或窗口正显示给人看时不算空闲", async () => {
    const session = await newSession();
    const stage = stageOf(session);
    expect(session.isPinned()).toBe(false);

    const pending = session.assertExpectations({ visible: "#never", timeout_ms: 400 });
    await vi.waitFor(() => expect(driverOf().evaluate).toHaveBeenCalled());
    expect(session.isPinned()).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "E_ASSERTION_FAILED" });
    expect(session.isPinned()).toBe(false);

    await session.watch({ show: true });
    expect(session.isPinned()).toBe(true);
    await session.watch({ show: false });
    expect(session.isPinned()).toBe(false);
    await session.close();
    expect(session.isPinned()).toBe(false);
    expect(stage.closed).toBe(true);
  });

  it("关闭会话时，进行中的操作立刻以 E_SESSION_NOT_FOUND 失败而不是挂住", async () => {
    const session = await newSession();
    const pending = session.assertExpectations({ visible: "#never", timeout_ms: 60_000 });
    const settled = vi.fn();
    void pending.then(settled, settled);
    await vi.waitFor(() => expect(driverOf().evaluate).toHaveBeenCalled());

    await session.close();
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());
    await expect(pending).rejects.toMatchObject({
      code: "E_SESSION_NOT_FOUND",
      message: expect.stringContaining("操作进行中被关闭"),
    });
    // 关闭之后再来的操作直接 404，不碰页面
    await expect(session.navigate("https://example.com")).rejects.toMatchObject({
      code: "E_SESSION_NOT_FOUND",
    });
  });
});

describe("BrowserSession 窗口状态", () => {
  it("人关掉窗口后会话还在：记一条 window.closed，下次 watch 照常再弹出来", async () => {
    const session = await newSession();
    const stage = stageOf(session);

    await session.watch({ show: true });
    expect(session.summary().visible).toBe(true);

    stage.humanClose();
    expect(session.isClosed()).toBe(false);
    expect(session.summary().visible).toBe(false);
    expect(session.eventsAfter(0).map((event) => event.type)).toContain("window.closed");

    const shown = await session.watch({ show: true });
    expect(shown).toMatchObject({ visible: true, window: "shown" });
    expect(stageOf(session)).toBe(stage);
    await session.close();
  });

  it("隐藏窗口后 watch 如实回报不可见", async () => {
    const session = await newSession();
    expect(await session.watch({ show: true })).toMatchObject({ visible: true, window: "shown" });
    expect(await session.watch({ show: false })).toMatchObject({ visible: false, window: "hidden" });
    expect(session.summary().visible).toBe(false);
    await session.close();
  });
});

describe("BrowserSession 抢前台开关", () => {
  it("默认拒绝 focus=true：窗口只以不抢焦点的方式出现，login 也一样", async () => {
    const session = await newSession();
    const stage = stageOf(session);

    await expect(session.watch({ show: true, focus: true })).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
      message: expect.stringContaining("--allow-focus"),
    });
    expect(stage.visible).toBe(false);
    await expect(session.login({ mode: "watch", focus: true })).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
      message: expect.stringContaining("--allow-focus"),
    });
    // 不带 focus 的请求照常
    expect(await session.watch({ show: true })).toMatchObject({ focused: false });
    await session.close();
  });

  it("daemon 以 --allow-focus 启动时才接受 focus=true", async () => {
    const session = await newSession({ allowFocus: true });
    const showForHuman = vi.spyOn(stageOf(session), "showForHuman");

    expect(await session.watch({ show: true, focus: true })).toMatchObject({ focused: true });
    expect(showForHuman).toHaveBeenLastCalledWith("focused");
    expect(await session.watch({ show: true })).toMatchObject({ focused: false });
    expect(showForHuman).toHaveBeenLastCalledWith("inactive");
    await session.close();
  });
});

describe("BrowserSession 页面被外部销毁", () => {
  it("记一条 page.destroyed、通知管理方，之后的摘要不再抛错，会话仍能正常关掉", async () => {
    const onPageLost = vi.fn();
    const session = await newSession({ onPageLost });
    const stage = stageOf(session);

    stage.losePage();

    expect(session.isPageLost()).toBe(true);
    expect(onPageLost).toHaveBeenCalledExactlyOnceWith(session);
    expect(session.eventsAfter(0).map((event) => event.type)).toContain("page.destroyed");
    expect(session.summary()).toMatchObject({ session_id: session.id, url: "", title: "" });
    await expect(session.close()).resolves.toBeUndefined();
    expect(stage.closed).toBe(true);
  });

  it("自己关会话时页面随之销毁，不算页面丢失", async () => {
    const onPageLost = vi.fn();
    const session = await newSession({ onPageLost });

    await session.close();

    expect(onPageLost).not.toHaveBeenCalled();
    expect(session.isPageLost()).toBe(false);
  });
});
