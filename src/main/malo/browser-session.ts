import crypto from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError, isDemoError } from "../../shared/errors";
import type {
  MaloAction,
  MaloActionResult,
  MaloAssertInput,
  MaloAssertResult,
  MaloExtractResult,
  MaloLightObservation,
  MaloLoginInput,
  MaloLoginResult,
  MaloNavigationDiagnostics,
  MaloNetworkCaptureState,
  MaloNetworkInfo,
  MaloEventsPage,
  MaloObservation,
  MaloPopupInfo,
  MaloResponsesResult,
  MaloRunReport,
  MaloSessionSummary,
  MaloSnapshot,
  MaloWatchResult,
} from "../../shared/malo";
import { ElectronPageDriver } from "../electron-page-driver";
import { sleep } from "../tools";
import { StageWindow } from "../windows/stage-window";
import { runAction } from "./actions/run-action";
import { checkExpectations } from "./assert-flow";
import { EventLog } from "./event-log";
import { extractElements, type ExtractInput } from "./extract";
import {
  HUMAN_BLOCK_MESSAGES,
  applyHumanSignal,
  consumeHumanDone,
  humanBlock,
  initialHumanState,
  type HumanSignal,
} from "./human-signals";
import { runLogin } from "./login-flow";
import { navigatePage } from "./navigation";
import { GRANTABLE_PERMISSIONS } from "./permissions";
import { observePage } from "./observation";
import { attachPartitionHooks } from "./partition-hooks";
import { removePartitionDir } from "./profile-store";
import { NetworkCapture } from "./network-capture";
import { validateUrl } from "./navigation";
import type { BrowserSessionOptions, WatchInput } from "./session-internals";
import { snapshotPage, type SnapshotInput } from "./snapshot";
import { withTimeout } from "./timeouts";

export type { BrowserSessionOptions } from "./session-internals";

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const MAX_NETWORK_FAILURES = 40;
const MAX_CONSOLE_ERRORS = 20;

function debug(message: string): void {
  if (process.env.DEMO_DEBUG) console.error(`[malo] ${message}`);
}

function sessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function safeDownloadName(raw: string): string {
  const base = path.basename(raw || "download");
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "download" : cleaned;
}

export class BrowserSession {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly profile: string | null;
  readonly downloadsDir: string;
  readonly artifactsDir: string;
  readonly createdAt: string;
  /** 会话事件落盘文件（JSONL），会话关闭后保留到租约目录被清扫。 */
  readonly eventsLog: string;

  readonly stage: StageWindow;
  private readonly partitionName: string;
  readonly driver: ElectronPageDriver;
  readonly capture: NetworkCapture;
  private readonly log: EventLog;
  private detachHooks: (() => void) | null = null;
  private lastUsedMs = Date.now();
  popupSeq = 0;
  lastPopup: MaloPopupInfo | null = null;
  human = initialHumanState();
  readonly permissions: string[];
  readonly failedRequests: MaloNetworkInfo["failures"] = [];
  readonly consoleErrors: MaloNetworkInfo["console_errors"] = [];
  navigationState: MaloNavigationDiagnostics | null = null;
  closed = false;
  private pageLost = false;

  constructor(readonly options: BrowserSessionOptions) {
    this.id = options.sessionId ?? `session-${crypto.randomUUID()}`;
    this.token = sessionToken();
    this.name = options.name?.trim() || this.id;
    this.profile = options.profile ?? null;
    this.createdAt = new Date().toISOString();
    this.downloadsDir = path.join(options.rootDir, this.id, "downloads");
    this.artifactsDir = path.join(options.rootDir, this.id, "artifacts");
    this.eventsLog = path.join(this.artifactsDir, "events.jsonl");
    const unknownPermission = (options.permissions ?? []).find(
      (permission) => !(GRANTABLE_PERMISSIONS as readonly string[]).includes(permission),
    );
    if (unknownPermission !== undefined) {
      throw new Error(`不可放开的页面权限：${unknownPermission}；可选值：${GRANTABLE_PERMISSIONS.join("、")}`);
    }
    this.permissions = [...new Set(options.permissions ?? [])];
    this.log = new EventLog(this.eventsLog, options.eventLimit);
    const viewport = {
      width: options.width ?? DEFAULT_VIEWPORT.width,
      height: options.height ?? DEFAULT_VIEWPORT.height,
    };
    this.partitionName =
      this.profile === null
        ? `persist:malo-${options.leaseId}-${this.id}`
        : `persist:malo-profile-${this.profile}`;
    this.stage = new StageWindow({
      ...viewport,
      showMode: "hidden",
      partition: this.partitionName,
      title: `malo-browser - ${this.name}`,
      frame: true,
      toolbar: true,
      onWindowClosed: () => {
        this.record("window.closed");
      },
      onHumanSignal: (signal) => this.humanSignal(signal),
    });
    this.driver = new ElectronPageDriver(this.stage.view.webContents);
    this.capture = new NetworkCapture(this.driver);
  }

  // 驱动操作进行中的计数：回收器据此放过这个会话；会话关闭时进行中的操作立刻失败，
  // 不会挂在已销毁的页面上把租约一直占着。
  private inflight = 0;
  private readonly lifetime = new AbortController();

  async running<T>(op: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.inflight += 1;
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(this.closedWhileRunning());
        if (this.lifetime.signal.aborted) onAbort();
        else this.lifetime.signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([op(), aborted]);
    } catch (error) {
      // 会话在操作进行中被关闭：底层对象已销毁，错误统一成 E_SESSION_NOT_FOUND
      if (this.closed && !isDemoError(error)) throw this.closedWhileRunning();
      throw error;
    } finally {
      if (onAbort) this.lifetime.signal.removeEventListener("abort", onAbort);
      this.inflight -= 1;
    }
  }

  closedWhileRunning(): DemoError {
    return new DemoError("E_SESSION_NOT_FOUND", `session 在操作进行中被关闭：${this.id}`);
  }

  static async create(options: BrowserSessionOptions): Promise<BrowserSession> {
    debug(`session create start lease=${options.leaseId}`);
    const session = new BrowserSession(options);
    try {
      debug(`session ${session.id}: stage created`);
      await mkdir(session.downloadsDir, { recursive: true, mode: 0o700 });
      await mkdir(session.artifactsDir, { recursive: true, mode: 0o700 });
      debug(`session ${session.id}: dirs ready`);
      await session.prepareWebContents();
      debug(`session ${session.id}: webContents prepared`);
      await withTimeout(
        session.driver.attach(),
        15_000,
        `session ${session.id} 的 CDP 初始化超过 15 秒`,
      );
      debug(`session ${session.id}: driver attached`);
      session.record("session.created", { name: session.name, profile: session.profile });
      return session;
    } catch (error) {
      session.abortCreate();
      throw error;
    }
  }

  private async prepareWebContents(): Promise<void> {
    const wc = this.stage.view.webContents;
    const partitionSession = wc.session;
    wc.setWindowOpenHandler((details) => {
      // 弹窗一律不开新窗口（一个会话只有一个页面）：拦下的目标地址带回给 agent，
      // adopt 模式下直接在当前页面打开，等价于「点开了新窗口的链接」
      const popup = { seq: this.popupSeq + 1, url: details.url, adopted: false };
      this.popupSeq = popup.seq;
      this.lastPopup = popup;
      if (this.options.popup === "adopt" && /^https?:/i.test(details.url)) {
        popup.adopted = true;
        this.record("navigation.popup_adopted", { url: details.url, disposition: details.disposition });
        void wc.loadURL(details.url).catch((error: unknown) => {
          this.record("navigation.popup_adopt_failed", { url: details.url, reason: (error as Error).message });
        });
      } else {
        this.record("navigation.popup_blocked", { url: details.url, disposition: details.disposition });
      }
      return { action: "deny" };
    });
    wc.on("will-navigate", (event, target) => {
      try {
        validateUrl(target);
      } catch (error) {
        event.preventDefault();
        this.record("navigation.blocked", { target, reason: (error as Error).message });
      }
    });
    wc.on("will-redirect", (event, target) => {
      try {
        validateUrl(target);
      } catch (error) {
        event.preventDefault();
        this.record("navigation.redirect_blocked", { target, reason: (error as Error).message });
      }
    });
    // Sessions that share a profile share one Electron session, so all
    // partition-wide handlers are installed once and dispatched by webContents.
    this.detachHooks = attachPartitionHooks(partitionSession, {
      webContentsId: wc.id,
      onPermissionRequested: (permission) => {
        const granted = this.permissions.includes(permission);
        this.record(granted ? "permission.granted" : "permission.denied", { permission });
        return granted;
      },
      onDownload: (_event, item) => {
        const target = path.join(
          this.downloadsDir,
          `${Date.now()}-${safeDownloadName(item.getFilename())}`,
        );
        item.setSavePath(target);
        this.record("download.started", { target });
        item.once("done", (_doneEvent, state) => {
          this.record("download.finished", { target, state });
        });
      },
      onRequestFailed: (details) => {
        this.failedRequests.push({
          url: details.url.slice(0, 500),
          error: details.error ?? "",
          resource_type: details.resourceType,
        });
        if (this.failedRequests.length > MAX_NETWORK_FAILURES) this.failedRequests.shift();
      },
      onMainFrameCompleted: (statusCode) => {
        if (!this.navigationState) return;
        this.navigationState.http_status = statusCode;
      },
    });
    wc.on("did-start-loading", () => this.record("page.loading", { url: wc.getURL() }));
    wc.on("did-finish-load", () => this.record("page.loaded", { url: wc.getURL() }));
    wc.on("did-redirect-navigation", (details) => {
      if (!details.isMainFrame || !this.navigationState) return;
      this.navigationState.final_url = details.url;
      this.navigationState.redirects.push({ url: details.url, status: null });
      this.record("navigation.redirect", { url: details.url });
    });
    wc.on("did-navigate", (_event, target, httpResponseCode, httpStatusText) => {
      if (!this.navigationState) return;
      this.navigationState.final_url = target;
      this.navigationState.http_status = httpResponseCode > 0 ? httpResponseCode : null;
      this.navigationState.http_status_text = httpStatusText ?? "";
      this.navigationState.navigations += 1;
      this.record("navigation.committed", {
        url: target,
        http_status: httpResponseCode,
      });
    });
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || !this.navigationState) return;
      if (errorCode === -3) {
        this.record("navigation.aborted", { url: validatedURL });
        return;
      }
      this.navigationState.net_error = errorCode;
      this.navigationState.net_error_description = errorDescription;
      this.navigationState.final_url = validatedURL || this.navigationState.final_url;
      this.navigationState.load_state = "failed";
      this.record("navigation.net_error", {
        url: validatedURL,
        error_code: errorCode,
        error_description: errorDescription,
      });
    });
    wc.on("did-stop-loading", () => {
      this.record("page.stopped_loading", { url: wc.getURL() });
    });
    wc.on("console-message", (details) => {
      if (details.level !== "error" && details.level !== "warning") return;
      this.consoleErrors.push({
        message: details.message.slice(0, 500),
        source: details.sourceId,
        line: details.lineNumber,
      });
      if (this.consoleErrors.length > MAX_CONSOLE_ERRORS) this.consoleErrors.shift();
      if (details.level === "error") {
        this.record("console.error", {
          message: details.message.slice(0, 300),
          source: details.sourceId,
          line: details.lineNumber,
        });
      }
    });
    wc.on("render-process-gone", (_event, details) => {
      this.record("renderer.gone", {
        reason: details.reason,
        exit_code: details.exitCode,
      });
      if (this.navigationState) {
        this.navigationState.load_state = "failed";
        this.navigationState.net_error_description = `renderer ${details.reason}`;
      }
    });
    // 页面可以在会话之外被关掉（典型：经 CDP 调试口关页面目标）。此后这个会话什么都做不了，
    // 立刻收尾：否则关会话的流程会卡在已销毁的页面上，窗口一直留到进程退出。
    wc.on("destroyed", () => {
      if (this.closed) return;
      this.pageLost = true;
      this.record("page.destroyed");
      this.options.onPageLost?.(this);
    });
    await wc.loadURL("about:blank");
  }

  touch(): void {
    this.lastUsedMs = Date.now();
  }

  idleMs(now = Date.now()): number {
    return Math.max(0, now - this.lastUsedMs);
  }

  isClosed(): boolean {
    return this.closed;
  }

  isPageLost(): boolean {
    return this.pageLost;
  }

  /**
   * 空闲回收不碰的会话：有操作正在进行，或者窗口正显示给人看
   * （人还在登录/核对，5 分钟没发请求是常态）。
   */
  isPinned(): boolean {
    return !this.closed && (this.inflight > 0 || this.stage.isVisible());
  }

  summary(): MaloSessionSummary {
    const wc = this.stage.view.webContents;
    const alive = wc !== undefined && !wc.isDestroyed();
    return {
      session_id: this.id,
      name: this.name,
      profile: this.profile,
      url: alive ? wc.getURL() : "",
      title: alive ? wc.getTitle() : "",
      created_at: this.createdAt,
      last_used_at: new Date(this.lastUsedMs).toISOString(),
      visible: this.stage.isVisible(),
      human: { ...this.human },
      permissions: [...this.permissions],
    };
  }

  /** 人在 watch 窗口的工具条上点了完成 / 暂停 / 继续 / 停止。 */
  humanSignal(signal: HumanSignal): void {
    const next = applyHumanSignal(this.human, signal);
    if (next.event === null) return;
    this.human = next.state;
    this.record(next.event);
    this.stage.setHumanState(this.human);
  }

  /** agent 要动页面之前查一下：人喊了暂停或停止就不能动。观察类操作不走这里。 */
  assertAgentMayAct(): void {
    const block = humanBlock(this.human);
    if (block !== null) throw new DemoError(block, HUMAN_BLOCK_MESSAGES[block]);
  }

  /** 取走人点过的「完成」：拿到后清掉并同步面板，下一轮交接还能再点。 */
  takeHumanDone(): boolean {
    const taken = consumeHumanDone(this.human);
    if (!taken.done) return false;
    this.human = taken.state;
    this.stage.setHumanState(this.human);
    this.record("human.done_taken");
    return true;
  }

  async waitHumanDone(timeoutMs: number): Promise<void> {
    this.assertOpen();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.assertOpen();
      if (this.takeHumanDone()) return;
      if (Date.now() >= deadline) {
        throw new DemoError(
          "E_STEP_TIMEOUT",
          `${timeoutMs}ms 内人没有在面板上点「完成」：窗口要先用 watch 显示出来，工具条上才有这个按钮`,
        );
      }
      await sleep(100);
    }
  }

  async navigate(
    rawUrl: string,
    timeoutMs = 30_000,
    settleMs = 6_000,
  ): Promise<MaloLightObservation> {
    this.assertAgentMayAct();
    return this.running(() => navigatePage(this, rawUrl, timeoutMs, settleMs));
  }

  observe(
    mode: "light" | "screenshot",
    maxChars = 2_000,
    clipSelector?: string,
  ): Promise<MaloObservation> {
    return observePage(this, mode, maxChars, clipSelector);
  }

  snapshot(input: SnapshotInput = {}): Promise<MaloSnapshot> {
    return snapshotPage(this, input);
  }
  extract(input: ExtractInput): Promise<MaloExtractResult> {
    return extractElements(this, input);
  }

  assertExpectations(input: MaloAssertInput): Promise<MaloAssertResult> {
    return this.running(() => checkExpectations(this, input));
  }

  async saveRunReport(report: Omit<MaloRunReport, "report_path">): Promise<string> {
    this.assertOpen();
    this.touch();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(this.artifactsDir, `run-${stamp}.json`);
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.record("run.finished", {
      ok: report.ok,
      step_count: report.step_count,
      failed_step: report.failed_step,
      report: target,
    });
    return target;
  }

  async act(action: MaloAction, timeoutMs = 10_000): Promise<MaloActionResult> {
    // 等待与休眠不动页面：人点「完成」之后 agent 正靠 wait_for 把这一轮交接接回来
    if (action.type !== "wait_for" && action.type !== "sleep") this.assertAgentMayAct();
    return this.running(() => runAction(this, action, timeoutMs));
  }

  async watch(input: WatchInput = {}): Promise<MaloWatchResult> {
    this.assertOpen();
    this.touch();
    const show = input.show !== false;
    const focus = input.focus === true;
    this.assertFocusAllowed(focus);
    if (input.width !== undefined || input.height !== undefined) {
      const rawWidth = Number(input.width ?? 1440);
      const rawHeight = Number(input.height ?? 900);
      if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight)) {
        throw new DemoError("E_BAD_REQUEST", "watch width/height 必须是数字");
      }
      const width = Math.max(640, Math.min(3840, Math.floor(rawWidth)));
      const height = Math.max(480, Math.min(2160, Math.floor(rawHeight)));
      this.stage.resize(width, height);
    }
    if (show) {
      this.stage.showForHuman(focus ? "focused" : "inactive");
      this.stage.setHumanState(this.human);
      this.record("watch.shown", { focus });
    } else {
      this.stage.hide();
      this.record("watch.hidden");
    }
    const wc = this.stage.view.webContents;
    const alive = wc !== undefined && !wc.isDestroyed();
    return {
      visible: this.stage.isVisible(),
      focused: focus,
      url: alive ? wc.getURL() : "",
      title: alive ? wc.getTitle() : "",
      window: show ? "shown" : "hidden",
    };
  }

  async login(input: MaloLoginInput): Promise<MaloLoginResult> {
    this.assertAgentMayAct();
    return this.running(() => runLogin(this, input));
  }

  eventsAfter(after: number, limit = 100): MaloEventsPage {
    return this.log.after(after, limit);
  }

  async networkCapture(input: { url_prefixes?: string[] }): Promise<MaloNetworkCaptureState> {
    this.assertOpen();
    this.touch();
    if (input.url_prefixes === undefined) return this.capture.state();
    const state = await this.capture.setSubscription(input.url_prefixes);
    this.record("network_capture.subscription", {
      prefixes: state.url_prefixes.length,
      captured: state.captured,
    });
    return state;
  }

  async responses(
    input: { url_prefix?: string; after?: number; limit?: number } = {},
  ): Promise<MaloResponsesResult> {
    this.assertOpen();
    this.touch();
    return this.capture.query(input);
  }

  record(type: string, detail?: Record<string, unknown>): void {
    this.log.record(type, detail);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 进行中的操作立刻以 E_SESSION_NOT_FOUND 失败，不挂在已销毁的页面上
    this.lifetime.abort();
    this.record("session.closed", { profile: this.profile });
    this.detachHooks?.();
    this.detachHooks = null;
    const wc = this.stage.view.webContents;
    if (this.profile === null && wc !== undefined && !wc.isDestroyed()) {
      try {
        await wc.session.clearStorageData();
        await wc.session.clearCache();
      } catch (error) {
        console.error(`[malo] 清理 session 存储失败：${(error as Error).message}`);
      }
    }
    this.capture.dispose();
    this.driver.detach();
    this.stage.close();
    if (this.profile === null && this.options.partitionsDir !== undefined) {
      await removePartitionDir(this.options.partitionsDir, this.partitionName);
    }
    // 事件落盘写完再返回：调用方拿到关闭结果时，审计文件是完整的
    await this.log.flush();
  }

  private abortCreate(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.detachHooks?.();
    this.detachHooks = null;
    try {
      this.driver.detach();
    } catch {
      // the debugger may never have attached when creation failed early
    }
    this.capture.dispose();
    this.stage.close();
  }

  async captureFailure(): Promise<string | null> {
    try {
      const target = path.join(this.artifactsDir, `failure-${Date.now()}.png`);
      await this.driver.screenshot(target);
      return target;
    } catch {
      return null;
    }
  }

  assertOpen(): void {
    if (this.closed) throw new DemoError("E_SESSION_NOT_FOUND", `session 已关闭：${this.id}`);
  }

  /** 把窗口带到前台会打断人正在做的事：daemon 不核实得了人是否同意，所以默认只给不抢焦点的方式。 */
  assertFocusAllowed(focus: boolean): void {
    if (!focus || this.options.allowFocus === true) return;
    throw new DemoError(
      "E_BAD_REQUEST",
      "focus=true 被拒绝：daemon 需要以 --allow-focus 启动才接受它。" +
        "窗口默认只以不抢焦点的方式出现，需要前台请人自己点窗口或 Dock 图标",
    );
  }
}