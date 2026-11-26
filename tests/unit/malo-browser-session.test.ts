import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserSession,
  type BrowserSessionOptions,
} from "../../src/main/malo/browser-session";

// vi.mock 的工厂在模块求值时执行，早于测试文件顶层语句，所以假实现放在 vi.hoisted 里
const fake = vi.hoisted(() => {
  type PopupDetails = { url: string; disposition: string };
  function fakeWebContents() {
    const handlers = new Map<string, () => void>();
    const openHandler = { current: null as null | ((details: PopupDetails) => { action: string }) };
    return {
      destroyed: false,
      id: 7,
      session: {
        permissionHandler: null as null | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void),
        setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (granted: boolean) => void) => void) {
          this.permissionHandler = handler;
        },
        on() {},
        async clearStorageData() {},
        async clearCache() {},
        webRequest: { onErrorOccurred() {}, onCompleted() {} },
      },
      loadURL: vi.fn(async () => undefined),
      setWindowOpenHandler(handler: (details: PopupDetails) => { action: string }) {
        openHandler.current = handler;
      },
      /** 页面调了 window.open */
      openPopup(url: string) {
        return openHandler.current?.({ url, disposition: "new-window" }) ?? { action: "allow" };
      },
      on(event: string, handler: () => void) {
        handlers.set(event, handler);
      },
      emit(event: string) {
        handlers.get(event)?.();
      },
      isDestroyed() {
        return this.destroyed;
      },
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
    humanStates: Array<{ done: boolean; paused: boolean; stopped: boolean }> = [];
    setHumanState(state: { done: boolean; paused: boolean; stopped: boolean }) {
      this.humanStates.push({ ...state });
    }
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
    expect(session.eventsAfter(0).events.map((event) => event.type)).toContain("window.closed");

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
    expect(session.eventsAfter(0).events.map((event) => event.type)).toContain("page.destroyed");
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

describe("BrowserSession 弹窗", () => {
  it("默认拦下 window.open，记下目标地址；动作期间触发的弹窗随动作结果带回", async () => {
    const session = await newSession();
    const stage = stageOf(session);
    const page = stage.view.webContents;

    expect(page.openPopup("https://example.com/pop?x=1")).toEqual({ action: "deny" });
    expect(session.lastPopup).toEqual({ seq: 1, url: "https://example.com/pop?x=1", adopted: false });
    expect(session.eventsAfter(0).events.at(-1)).toMatchObject({
      type: "navigation.popup_blocked",
      detail: { url: "https://example.com/pop?x=1", disposition: "new-window" },
    });
    // 创建会话时只加载过 about:blank，弹窗地址没有被打开
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");

    // 动作执行期间页面弹窗：结果里带上 popup
    const popupBefore = session.popupSeq;
    driverOf().evaluate.mockImplementationOnce(async () => {
      page.openPopup("https://example.com/pop?x=2");
      return ASSERT_STATE;
    });
    const result = await session.act({ type: "sleep", ms: 0 });
    expect(result.popup).toEqual({ seq: popupBefore + 1, url: "https://example.com/pop?x=2", adopted: false });
    // 没有弹窗的动作不带这个字段
    driverOf().evaluate.mockResolvedValue(ASSERT_STATE);
    expect(await session.act({ type: "sleep", ms: 0 })).not.toHaveProperty("popup");
    await session.close();
  });

  it("adopt 模式：把弹窗地址在当前页面打开并标记 adopted；非 http(s) 的仍然只拦不开", async () => {
    const session = await newSession({ popup: "adopt" });
    const page = stageOf(session).view.webContents;

    expect(page.openPopup("https://example.com/next")).toEqual({ action: "deny" });
    expect(session.lastPopup).toEqual({ seq: 1, url: "https://example.com/next", adopted: true });
    expect(page.loadURL).toHaveBeenCalledWith("https://example.com/next");
    expect(session.eventsAfter(0).events.at(-1)?.type).toBe("navigation.popup_adopted");

    expect(page.openPopup("about:blank#blocked")).toEqual({ action: "deny" });
    expect(session.lastPopup).toEqual({ seq: 2, url: "about:blank#blocked", adopted: false });
    expect(page.loadURL.mock.calls.map(([url]) => url)).toEqual(["about:blank", "https://example.com/next"]);
    await session.close();
  });
});

describe("BrowserSession 事件留档", () => {
  it("分页返回事件并带游标与断档数；事件同时落到 events.jsonl，关闭后文件完整", async () => {
    const session = await newSession({ eventLimit: 4 });
    expect(session.eventsLog.endsWith("events.jsonl")).toBe(true);
    session.record("a");
    session.record("b");
    session.record("c");

    const page = session.eventsAfter(0, 100);
    // session.created + a/b/c 共 4 条，恰好占满缓冲
    expect(page.events.map((event) => event.type)).toEqual(["session.created", "a", "b", "c"]);
    expect(page.next_after).toBe(4);
    expect(page.dropped).toBe(0);
    expect(session.eventsAfter(0, 2)).toMatchObject({ next_after: 2, dropped: 0 });
    session.record("d");
    expect(session.eventsAfter(0, 100)).toMatchObject({ dropped: 1, next_after: 5 });

    await session.close();
    const written = (await readFile(session.eventsLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(written.map((event: { type: string }) => event.type)).toEqual([
      "session.created",
      "a",
      "b",
      "c",
      "d",
      "session.closed",
    ]);
  });
});

describe("BrowserSession 人的信号", () => {
  it("暂停期间动作类操作被拦成 E_PAUSED_BY_HUMAN，观察类照常；点继续后恢复", async () => {
    const session = await newSession();
    const stage = stageOf(session);

    session.humanSignal("pause");
    await expect(session.navigate("https://example.com")).rejects.toMatchObject({
      code: "E_PAUSED_BY_HUMAN",
      message: expect.stringContaining("「继续」"),
    });
    await expect(session.act({ type: "click", selector: "#x" })).rejects.toMatchObject({
      code: "E_PAUSED_BY_HUMAN",
    });
    // 等待不动页面：人点「完成」之后 agent 靠它把交接接回来
    await expect(session.act({ type: "sleep", ms: 0 })).resolves.toBeDefined();
    driverOf().evaluate.mockResolvedValue({ ...ASSERT_STATE, links: [], buttons: [], inputs: [], frames: [] });
    await expect(session.snapshot({ max_chars: 0 })).resolves.toMatchObject({ url: "about:blank" });

    session.humanSignal("resume");
    driverOf().evaluate.mockResolvedValue({ ...ASSERT_STATE });
    await expect(session.act({ type: "sleep", ms: 0 })).resolves.toBeDefined();
    expect(session.summary().human).toEqual({ done: false, paused: false, stopped: false });
    // 面板跟着状态走：暂停时推一次、继续时再推一次
    expect(stage.humanStates.map((state) => state.paused)).toEqual([true, false]);
    expect(session.eventsAfter(0).events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["human.paused", "human.resumed"]),
    );
    await session.close();
  });

  it("停止是终态：之后不能再操作页面，也收不到别的信号", async () => {
    const session = await newSession();

    session.humanSignal("stop");
    session.humanSignal("resume");
    session.humanSignal("done");
    await expect(session.act({ type: "click", selector: "#x" })).rejects.toMatchObject({
      code: "E_STOPPED_BY_HUMAN",
      message: expect.stringContaining("「停止」"),
    });
    await expect(session.login({ mode: "watch" })).rejects.toMatchObject({ code: "E_STOPPED_BY_HUMAN" });
    expect(session.summary().human).toEqual({ done: false, paused: false, stopped: true });
    await session.close();
  });

  it("wait_for human 等到人点「完成」才返回，并且只消费一次", async () => {
    const session = await newSession();
    const pending = session.act({ type: "wait_for", human: true, timeout_ms: 5_000 });
    await vi.waitFor(() => expect(session.isPinned()).toBe(true));

    session.humanSignal("done");
    await expect(pending).resolves.toBeDefined();
    expect(session.summary().human?.done).toBe(false);

    const second = session.act({ type: "wait_for", human: true, timeout_ms: 300 });
    await expect(second).rejects.toMatchObject({ code: "E_STEP_TIMEOUT", message: expect.stringContaining("「完成」") });
    await session.close();
  });

  it("wait_for human 不能带 frame", async () => {
    const session = await newSession();
    await expect(session.act({ type: "wait_for", human: true, frame: 0 } as never)).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
    await session.close();
  });

  it("页面权限默认全拒；点名放开的才放行，并留下 granted / denied 事件", async () => {
    const ask = (session: BrowserSession, permission: string) => {
      const partition = stageOf(session).view.webContents.session;
      const answers: boolean[] = [];
      partition.permissionHandler?.({ id: 7 }, permission, (granted) => answers.push(granted));
      partition.permissionHandler?.({ id: 99 }, permission, (granted) => answers.push(granted));
      return answers;
    };
    const plain = await newSession();
    expect(ask(plain, "clipboard-read")).toEqual([false, false]);
    expect(plain.eventsAfter(0).events.at(-1)?.type).toBe("permission.denied");

    const allowed = await newSession({ permissions: ["clipboard-read", "clipboard-read"] });
    expect(allowed.summary().permissions).toEqual(["clipboard-read"]);
    expect(ask(allowed, "clipboard-read")).toEqual([true, false]);
    expect(ask(allowed, "geolocation")).toEqual([false, false]);
    expect(allowed.eventsAfter(0).events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["permission.granted", "permission.denied"]),
    );
    await plain.close();
    await allowed.close();
  });

  it("拒绝创建带不可放开权限的会话", async () => {
    await expect(BrowserSession.create({ leaseId: "l", rootDir: os.tmpdir(), permissions: ["fileSystem"] as never[] })).rejects.toThrow(/不可放开的页面权限/);
  });
});
