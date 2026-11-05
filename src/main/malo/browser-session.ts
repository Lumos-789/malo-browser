import crypto from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError, stripErrorCode } from "../../shared/errors";
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
  MaloObservation,
  MaloResponsesResult,
  MaloRunReport,
  MaloSessionEvent,
  MaloSessionSummary,
  MaloSnapshot,
  MaloWatchResult,
} from "../../shared/malo";
import { ElectronPageDriver } from "../electron-page-driver";
import { sleep } from "../tools";
import { StageWindow } from "../windows/stage-window";
import type { MaloAssertState } from "./assertions";
import { buildAssertChecks, describeAssertFailure } from "./assertions";
import { NetworkCapture } from "./network-capture";
import { attachPartitionHooks } from "./partition-hooks";
import { removePartitionDir } from "./profile-store";

export type BrowserSessionOptions = {
  leaseId: string;
  sessionId?: string;
  name?: string;
  profile?: string;
  width?: number;
  height?: number;
  rootDir: string;
  partitionsDir?: string;
  eventLimit?: number;
};

const MAX_EVENT_LOG = 200;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const MAX_NETWORK_FAILURES = 40;
const MAX_CONSOLE_ERRORS = 20;

const SUPPORTED_KEY_NAMES: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `F${n}`),
]);

function isSupportedKey(key: string): boolean {
  return key.length === 1 || SUPPORTED_KEY_NAMES.has(key);
}

function looksLikeChallengeUrl(url: string): boolean {
  return /(?:js_challenge|jsc_token|jsc_orig_r|\/(?:challenge|captcha|verify)(?:\/|$))/i.test(url);
}

function debug(message: string): void {
  if (process.env.DEMO_DEBUG) console.error(`[malo] ${message}`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DemoError("E_CDP_ATTACH_FAILED", message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function safeDownloadName(raw: string): string {
  const base = path.basename(raw || "download");
  const cleaned = base.replace(/[^\w.\-() ]+/g, "_").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "download" : cleaned;
}

function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DemoError("E_NAV_BLOCKED", `无效 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DemoError("E_NAV_BLOCKED", `只允许 http/https 导航：${raw}`);
  }
  if (url.username || url.password) {
    throw new DemoError("E_NAV_BLOCKED", "URL 不允许包含 credentials");
  }
  return url.toString();
}

export class BrowserSession {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly profile: string | null;
  readonly downloadsDir: string;
  readonly artifactsDir: string;
  readonly createdAt: string;

  private readonly stage: StageWindow;
  private readonly partitionName: string;
  private readonly driver: ElectronPageDriver;
  private readonly capture: NetworkCapture;
  private detachHooks: (() => void) | null = null;
  private lastUsedMs = Date.now();
  private eventSeq = 0;
  private readonly events: MaloSessionEvent[] = [];
  private readonly failedRequests: MaloNetworkInfo["failures"] = [];
  private readonly consoleErrors: MaloNetworkInfo["console_errors"] = [];
  private navigationState: MaloNavigationDiagnostics | null = null;
  private closed = false;

  private constructor(private readonly options: BrowserSessionOptions) {
    this.id = options.sessionId ?? `session-${crypto.randomUUID()}`;
    this.token = sessionToken();
    this.name = options.name?.trim() || this.id;
    this.profile = options.profile ?? null;
    this.createdAt = new Date().toISOString();
    this.downloadsDir = path.join(options.rootDir, this.id, "downloads");
    this.artifactsDir = path.join(options.rootDir, this.id, "artifacts");
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
    });
    this.driver = new ElectronPageDriver(this.stage.view.webContents);
    this.capture = new NetworkCapture(this.driver);
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
    wc.setWindowOpenHandler(() => {
      this.record("navigation.popup_blocked");
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
        this.record("permission.denied", { permission });
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

  summary(): MaloSessionSummary {
    const wc = this.stage.view.webContents;
    return {
      session_id: this.id,
      name: this.name,
      profile: this.profile,
      url: wc.getURL(),
      title: wc.getTitle(),
      created_at: this.createdAt,
      last_used_at: new Date(this.lastUsedMs).toISOString(),
    };
  }

  async navigate(
    rawUrl: string,
    timeoutMs = 30_000,
    settleMs = 6_000,
  ): Promise<MaloLightObservation> {
    this.assertOpen();
    const url = validateUrl(rawUrl);
    const boundedTimeout = Math.max(100, Math.min(120_000, Math.floor(timeoutMs)));
    const boundedSettle = Math.max(0, Math.min(15_000, Math.floor(settleMs)));
    this.touch();
    this.failedRequests.length = 0;
    this.consoleErrors.length = 0;
    this.navigationState = {
      requested_url: url,
      final_url: url,
      http_status: null,
      http_status_text: "",
      load_state: "timeout",
      net_error: null,
      net_error_description: null,
      navigations: 0,
      redirects: [],
      started_at: new Date().toISOString(),
      finished_at: null,
      settle: { waited_ms: 0, ready_state: "", dom_elements: 0, stable_samples: 0 },
    };
    this.record("navigation.started", { url });

    let loadError: unknown = null;
    try {
      await this.driver.navigate(url, { timeoutMs: boundedTimeout });
    } catch (error) {
      loadError = error;
    }

    const settle = await this.settleNavigation(boundedSettle);
    const wc = this.stage.view.webContents;
    const state = this.navigationState;
    state.final_url = wc.getURL() || state.final_url;
    state.finished_at = new Date().toISOString();
    state.settle = settle;

    const hardFailure =
      state.net_error !== null ||
      state.final_url.startsWith("chrome-error://") ||
      (loadError !== null && settle.dom_elements < 20);

    if (hardFailure) {
      state.load_state = state.net_error !== null || state.final_url.startsWith("chrome-error://")
        ? "failed"
        : "timeout";
      const screenshotPath = await this.captureFailure();
      const reason =
        state.net_error_description ??
        (loadError instanceof Error ? loadError.message : String(loadError ?? "页面未加载"));
      this.record("navigation.failed", {
        url,
        final_url: state.final_url,
        net_error: state.net_error,
        reason,
        screenshotPath,
      });
      throw new DemoError("E_NAV_FAILED", reason, {
        url,
        screenshotPath: screenshotPath ?? undefined,
        details: {
          navigation: state,
          failed_requests: this.failedRequests.slice(-5),
          console_errors: this.consoleErrors.slice(-5),
        },
      });
    }

    state.load_state = loadError ? "partial" : "complete";
    this.record("navigation.finished", {
      url,
      final_url: state.final_url,
      load_state: state.load_state,
    });
    const observation = await this.observe("light", 2_000);
    return { ...observation, navigation: state };
  }

  private async settleNavigation(
    maxMs: number,
  ): Promise<MaloNavigationDiagnostics["settle"]> {
    const started = Date.now();
    let lastUrl = "";
    let lastElements = -1;
    let stableSamples = 0;
    let lastChangeMs = started;
    let readyState = "";
    let domElements = 0;
    let lastNetworkIdleMs = this.driver.lastLifecycleAt("networkAlmostIdle") ?? 0;

    while (Date.now() - started < maxMs) {
      const stamp = await withTimeout(
        this.driver.evaluate<{ url: string; ready: string; elements: number }>(
          "({url: location.href, ready: document.readyState, elements: document.querySelectorAll('*').length})",
        ),
        800,
        "DOM 稳定采样超时",
      ).catch(() => null);
      if (stamp) {
        if (stamp.url !== lastUrl || stamp.elements !== lastElements) {
          lastUrl = stamp.url;
          lastElements = stamp.elements;
          lastChangeMs = Date.now();
          stableSamples = 0;
        } else {
          stableSamples += 1;
        }
        readyState = stamp.ready;
        domElements = stamp.elements;
      }
      lastNetworkIdleMs = Math.max(
        lastNetworkIdleMs,
        this.driver.lastLifecycleAt("networkAlmostIdle") ?? 0,
      );
      const elapsed = Date.now() - started;
      const quietFor = Date.now() - Math.max(lastChangeMs, lastNetworkIdleMs, started);
      const challenge = looksLikeChallengeUrl(lastUrl);
      const readyEnough = readyState === "complete" || readyState === "interactive";
      if (elapsed >= 400 && quietFor >= 600 && readyEnough && (!challenge || domElements > 50)) {
        break;
      }
      if (elapsed >= 1_500 && readyState === "complete" && stableSamples >= 10) break;
      await sleep(100);
    }

    return {
      waited_ms: Date.now() - started,
      ready_state: readyState,
      dom_elements: domElements,
      stable_samples: stableSamples,
    };
  }

  async observe(mode: "light" | "screenshot", maxChars = 2_000): Promise<MaloObservation> {
    this.assertOpen();
    this.touch();
    const requested = Number.isFinite(maxChars) ? Math.floor(maxChars) : 2_000;
    const limit = Math.max(0, Math.min(20_000, requested));
    const base = await this.driver.evaluate<MaloLightObservation>(`(() => {
      const body = document.body;
      const text = (body && body.innerText ? body.innerText : "").replace(/\\s+/g, " ").trim();
      return {
        url: location.href,
        title: document.title || "",
        ready_state: document.readyState,
        loading: false,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        dom: {
          elements: document.querySelectorAll("*").length,
          interactive: document.querySelectorAll('a,button,input,select,textarea,[role="button"],[contenteditable="true"]').length,
          text_length: text.length
        },
        body_text: text.slice(0, ${JSON.stringify(limit)}),
        runtime: {
          user_agent: navigator.userAgent,
          webdriver: navigator.webdriver === true,
          online: navigator.onLine,
          visibility_state: document.visibilityState,
          hardware_concurrency: navigator.hardwareConcurrency || 0
        }
      };
    })()`);
    base.loading = this.stage.view.webContents.isLoading();
    base.navigation = this.navigationState ? { ...this.navigationState } : undefined;
    base.network = {
      failed_requests: this.failedRequests.length,
      failures: this.failedRequests.slice(-5),
      console_errors: this.consoleErrors.slice(-5),
    };
    if (mode === "light") return base;
    const shot = await this.driver.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    this.record("observe.screenshot", { bytes: Buffer.byteLength(shot.data, "base64") });
    return {
      ...base,
      screenshot: { mime_type: "image/png", base64: shot.data },
    };
  }

  async snapshot(maxChars = 8_000, maxItems = 120): Promise<MaloSnapshot> {
    this.assertOpen();
    this.touch();
    const limitChars = Math.max(0, Math.min(30_000, Math.floor(maxChars)));
    const limitItems = Math.max(1, Math.min(500, Math.floor(maxItems)));
    const snapshot = await this.driver.evaluate<MaloSnapshot>(`(() => {
      const maxChars = ${JSON.stringify(limitChars)};
      const maxItems = ${JSON.stringify(limitItems)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const clip = (value, size) => value.length > size ? value.slice(0, size) : value;
      const selectorFor = (el) => {
        if (!el || el.nodeType !== 1) return "";
        const demo = el.getAttribute("data-demo-id");
        if (demo) return '[data-demo-id="' + CSS.escape(demo) + '"]';
        const testId = el.getAttribute("data-testid");
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        if (el.id) return "#" + CSS.escape(el.id);
        const name = el.getAttribute("name");
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const aria = el.getAttribute("aria-label");
        if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && node !== document.body) {
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
            if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
          }
          parts.unshift(part);
          node = parent;
        }
        return parts.join(" > ");
      };
      const visible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const textOf = (el) => clip(clean(
        el.tagName === "INPUT" && el.type === "password"
          ? "[redacted]"
          : (el.innerText || el.textContent || el.value || "")
      ), 300);
      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      };
      const labelOf = (el) => {
        const aria = el.getAttribute("aria-label");
        if (aria) return clip(clean(aria), 200);
        if (el.id) {
          const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (label) return clip(clean(label.innerText), 200);
        }
        const closest = el.closest("label");
        return closest ? clip(clean(closest.innerText), 200) : "";
      };
      const truncated = {
        headings: false, links: false, buttons: false, inputs: false, selects: false,
        forms: false, tables: false, landmarks: false, interactive: false,
        frames: false, dialogs: false, messages: false, text: false
      };
      const take = (list, item, key) => {
        if (list.length < maxItems) list.push(item);
        else truncated[key] = true;
      };

      const headings = [];
      for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
        if (!visible(el)) continue;
        take(headings, { level: Number(el.tagName.slice(1)), text: textOf(el), selector: selectorFor(el) }, "headings");
      }

      const links = [];
      for (const el of document.querySelectorAll("a[href]")) {
        if (!visible(el)) continue;
        take(links, { text: textOf(el), href: el.href, selector: selectorFor(el) }, "links");
      }

      const buttons = [];
      for (const el of document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')) {
        if (!visible(el)) continue;
        take(buttons, { text: textOf(el), selector: selectorFor(el), disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true" }, "buttons");
      }

      const inputs = [];
      for (const el of document.querySelectorAll('input:not([type="hidden"]),textarea')) {
        if (!visible(el)) continue;
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        const sensitive = type === "password";
        take(inputs, {
          type,
          name: el.getAttribute("name") || "",
          placeholder: el.getAttribute("placeholder") || "",
          label: labelOf(el),
          selector: selectorFor(el),
          value: sensitive ? "" : clip(String(el.value || ""), 200),
          sensitive
        }, "inputs");
      }

      const selects = [];
      for (const el of document.querySelectorAll("select")) {
        if (!visible(el)) continue;
        take(selects, {
          name: el.getAttribute("name") || "",
          selector: selectorFor(el),
          value: String(el.value || ""),
          options: Array.from(el.options).slice(0, 50).map((option) => clean(option.text))
        }, "selects");
      }

      const forms = [];
      for (const el of document.querySelectorAll("form")) {
        if (!visible(el)) continue;
        take(forms, {
          action: el.action || "",
          method: (el.method || "get").toLowerCase(),
          selector: selectorFor(el),
          fields: el.elements ? el.elements.length : 0
        }, "forms");
      }

      const tables = [];
      for (const table of document.querySelectorAll("table")) {
        if (!visible(table)) continue;
        const headRow = table.querySelector("thead tr") || table.querySelector("tr");
        const headers = headRow
          ? Array.from(headRow.querySelectorAll("th,td")).map((cell) => clip(clean(cell.innerText), 120))
          : [];
        const rows = [];
        let tableTruncated = false;
        for (const tr of table.querySelectorAll("tbody tr, tr")) {
          if (tr === headRow) continue;
          if (rows.length >= 30) { tableTruncated = true; break; }
          const cells = Array.from(tr.querySelectorAll("th,td")).map((cell) => clip(clean(cell.innerText), 120));
          if (cells.length > 0) rows.push(cells);
        }
        if (tableTruncated) truncated.tables = true;
        take(tables, { headers, rows, truncated: tableTruncated }, "tables");
      }

      const landmarks = [];
      const roleFor = (el) => el.getAttribute("role") || ({
        HEADER: "banner", NAV: "navigation", MAIN: "main", ASIDE: "complementary",
        FOOTER: "contentinfo", FORM: "form"
      }[el.tagName] || "");
      for (const el of document.querySelectorAll('header,nav,main,aside,footer,form,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="region"]')) {
        if (!visible(el)) continue;
        take(landmarks, {
          role: roleFor(el),
          label: clip(clean(el.getAttribute("aria-label") || el.querySelector("h1,h2,h3")?.innerText || ""), 200),
          selector: selectorFor(el)
        }, "landmarks");
      }

      const interactive = [];
      const seen = new Set();
      for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])')) {
        if (!visible(el) || seen.has(el)) continue;
        seen.add(el);
        take(interactive, {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: textOf(el),
          selector: selectorFor(el),
          rect: rectOf(el)
        }, "interactive");
      }

      const frames = [];
      for (const el of document.querySelectorAll("iframe")) {
        if (!visible(el)) continue;
        take(frames, { url: el.src || "", name: el.name || "", title: el.title || "" }, "frames");
      }

      const dialogs = [];
      for (const el of document.querySelectorAll('dialog[open],[role="dialog"]')) {
        if (!visible(el)) continue;
        take(dialogs, { text: clip(textOf(el), 1000), selector: selectorFor(el) }, "dialogs");
      }

      const messages = [];
      for (const el of document.querySelectorAll('[role="alert"],[aria-live]')) {
        if (!visible(el)) continue;
        take(messages, { text: clip(textOf(el), 1000), selector: selectorFor(el) }, "messages");
      }

      const body = document.body;
      const text = clean(body && body.innerText ? body.innerText : "");
      if (text.length > maxChars) truncated.text = true;
      return {
        url: location.href,
        title: document.title || "",
        ready_state: document.readyState,
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
        text: text.slice(0, maxChars),
        text_length: text.length,
        headings, links, buttons, inputs, selects, forms, tables, landmarks, interactive, frames, dialogs, messages,
        truncated
      };
    })()`);
    this.record("observe.snapshot", {
      links: snapshot.links.length,
      buttons: snapshot.buttons.length,
      inputs: snapshot.inputs.length,
      text_length: snapshot.text_length,
    });
    return snapshot;
  }

  async extract(input: {
    selector: string;
    mode?: "text" | "html" | "attributes";
    attributes?: string[];
    maxChars?: number;
    all?: boolean;
  }): Promise<MaloExtractResult> {
    this.assertOpen();
    this.touch();
    if (typeof input.selector !== "string" || input.selector.trim() === "") {
      throw new DemoError("E_UNSUPPORTED", "extract.selector 必须是非空字符串");
    }
    const mode = input.mode ?? "text";
    if (mode !== "text" && mode !== "html" && mode !== "attributes") {
      throw new DemoError("E_UNSUPPORTED", "extract.mode 只能是 text / html / attributes");
    }
    const maxChars = Math.max(0, Math.min(20_000, Math.floor(input.maxChars ?? 4_000)));
    const attributes = Array.isArray(input.attributes)
      ? input.attributes.filter((item): item is string => typeof item === "string").slice(0, 40)
      : [];
    const all = input.all !== false;
    await this.assertValidSelector(input.selector);
    const result = await this.driver.evaluate<MaloExtractResult>(`(() => {
      const selector = ${JSON.stringify(input.selector)};
      const mode = ${JSON.stringify(mode)};
      const maxChars = ${JSON.stringify(maxChars)};
      const all = ${JSON.stringify(all)};
      const attributes = ${JSON.stringify(attributes)};
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const clip = (value, size) => value.length > size ? value.slice(0, size) : value;
      const selectorFor = (el) => {
        if (el.getAttribute("data-demo-id")) return '[data-demo-id="' + CSS.escape(el.getAttribute("data-demo-id")) + '"]';
        if (el.id) return "#" + CSS.escape(el.id);
        const name = el.getAttribute("name");
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        return el.tagName.toLowerCase();
      };
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      let nodes = Array.from(document.querySelectorAll(selector));
      const total = nodes.length;
      if (!all) nodes = nodes.slice(0, 1);
      else nodes = nodes.slice(0, 50);
      const matches = nodes.map((el) => {
        const item = { selector: selectorFor(el), tag: el.tagName.toLowerCase(), visible: visible(el) };
        if (mode === "text") {
          const raw = el.tagName === "INPUT" && el.type === "password"
            ? "[redacted]"
            : (el.innerText || el.textContent || el.value || "");
          item.text = clip(clean(raw), maxChars);
        }
        if (mode === "html") item.html = clip(el.outerHTML || "", maxChars);
        if (mode === "attributes") {
          const picked = {};
          const names = attributes.length > 0 ? attributes : Array.from(el.attributes).map((attr) => attr.name);
          for (const name of names) {
            const value = el.getAttribute(name);
            if (value !== null) picked[name] = clip(value, 1000);
          }
          item.attributes = picked;
        }
        return item;
      });
      return { selector, mode, count: total, matches, truncated: total > nodes.length };
    })()`);
    this.record("observe.extract", {
      selector: input.selector,
      mode,
      count: result.count,
    });
    return result;
  }

  async assertExpectations(input: MaloAssertInput): Promise<MaloAssertResult> {
    this.assertOpen();
    this.touch();
    const timeoutMs = Math.max(0, Math.min(120_000, Math.floor(input.timeout_ms ?? 5_000)));
    const started = Date.now();
    for (;;) {
      const state = await this.readAssertState(input);
      if (state.invalid_selector !== null) {
        throw new DemoError("E_BAD_REQUEST", `assert 选择器无效：${state.invalid_selector}`);
      }
      if (state.value_redacted) {
        throw new DemoError(
          "E_BAD_REQUEST",
          "不支持断言密码框的 value：密码字段永远读不到真实值，改用 visible 或页面上的登录态断言",
        );
      }
      const checks = buildAssertChecks(input, state);
      if (checks.every((check) => check.ok)) {
        const waited_ms = Date.now() - started;
        this.record("assert.passed", { checks: checks.length, waited_ms });
        return { ok: true, passed: true, checks, url: state.url, title: state.title, waited_ms };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeoutMs) {
        const screenshotPath = await this.captureFailure();
        this.record("assert.failed", {
          checks: checks.filter((check) => !check.ok),
          waited_ms: elapsed,
          screenshotPath,
        });
        throw new DemoError("E_ASSERTION_FAILED", `断言失败：${describeAssertFailure(checks)}`, {
          url: state.url,
          selector: input.selector,
          screenshotPath: screenshotPath ?? undefined,
          details: { checks, waited_ms: elapsed },
        });
      }
      await sleep(Math.min(200, timeoutMs - elapsed));
    }
  }

  private async readAssertState(input: MaloAssertInput): Promise<MaloAssertState> {
    const params = {
      selector: input.selector ?? null,
      visible: input.visible ?? null,
      hidden: input.hidden ?? null,
      text: input.text ?? null,
      wants_value: input.value !== undefined,
      wants_count: input.count !== undefined,
    };
    return this.driver.evaluate<MaloAssertState>(`(() => {
      const params = ${JSON.stringify(params)};
      const out = {
        url: location.href,
        title: document.title,
        visible: null,
        hidden_visible: null,
        text: null,
        value: null,
        value_redacted: false,
        count: null,
        invalid_selector: null,
      };
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      try {
        if (params.visible !== null) out.visible = isVisible(document.querySelector(params.visible));
        if (params.hidden !== null) out.hidden_visible = isVisible(document.querySelector(params.hidden));
        if (params.text !== null) {
          const host = params.selector ? document.querySelector(params.selector) : document.body;
          out.text = host ? (host.innerText || host.textContent || "").includes(params.text) : false;
        }
        if (params.wants_value) {
          const el = document.querySelector(params.selector);
          if (el && el.type === "password") {
            out.value_redacted = true;
          } else {
            out.value = el ? String(el.value ?? "") : null;
          }
        }
        if (params.wants_count) out.count = document.querySelectorAll(params.selector).length;
      } catch (error) {
        out.invalid_selector = String((error && error.message) || error);
      }
      return out;
    })()`);
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
    this.assertOpen();
    this.touch();
    const boundedTimeout = Math.max(100, Math.min(120_000, Math.floor(timeoutMs)));
    this.record("action.started", { action: action.type });
    try {
      const detail = await this.executeAction(action, boundedTimeout);
      const observation = await this.observe("light", 2_000);
      this.record("action.completed", { action: action.type, detail });
      return { action: action.type, detail, observation };
    } catch (error) {
      const screenshotPath = await this.captureFailure();
      const message = error instanceof Error ? error.message : String(error);
      this.record("action.failed", { action: action.type, message, screenshotPath });
      if (error instanceof DemoError) {
        throw new DemoError(error.code, stripErrorCode(error.code, message), {
          ...error.toDetail(),
          screenshotPath: screenshotPath ?? error.screenshotPath,
        });
      }
      throw new DemoError("E_UNSUPPORTED", message, { screenshotPath: screenshotPath ?? undefined });
    }
  }

  async watch(input: {
    show?: boolean;
    focus?: boolean;
    width?: number;
    height?: number;
  } = {}): Promise<MaloWatchResult> {
    this.assertOpen();
    this.touch();
    const show = input.show !== false;
    const focus = input.focus === true;
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
      this.record("watch.shown", { focus });
    } else {
      this.stage.hide();
      this.record("watch.hidden");
    }
    const wc = this.stage.view.webContents;
    return {
      visible: this.stage.isVisible(),
      focused: focus,
      url: wc.getURL(),
      title: wc.getTitle(),
      window: show ? "shown" : "hidden",
    };
  }

  async login(input: MaloLoginInput): Promise<MaloLoginResult> {
    this.assertOpen();
    this.touch();
    const requestedMode = input.mode ?? "auto";
    if (requestedMode !== "auto" && requestedMode !== "password" && requestedMode !== "watch") {
      throw new DemoError("E_BAD_REQUEST", "login.mode 只能是 auto / password / watch");
    }
    const hasCredentials =
      typeof input.username === "string" &&
      input.username !== "" &&
      typeof input.password === "string" &&
      input.password !== "";
    for (const field of [
      "username",
      "password",
      "username_selector",
      "password_selector",
      "submit_selector",
      "success_url_contains",
      "success_selector",
      "error_selector",
    ] as const) {
      if (input[field] !== undefined && typeof input[field] !== "string") {
        throw new DemoError("E_BAD_REQUEST", `login.${field} 必须是字符串`);
      }
    }
    const mode = requestedMode === "auto" ? (hasCredentials ? "password" : "watch") : requestedMode;
    if (mode === "password" && !hasCredentials) {
      throw new DemoError("E_BAD_REQUEST", "password 模式需要 username 和 password");
    }
    const rawTimeout = Number(input.timeout_ms ?? (mode === "watch" ? 180_000 : 30_000));
    if (!Number.isFinite(rawTimeout) || rawTimeout < 1_000 || rawTimeout > 600_000) {
      throw new DemoError("E_BAD_REQUEST", "login.timeout_ms 必须是 1000-600000 的毫秒数");
    }
    const timeoutMs = Math.floor(Math.max(1_000, Math.min(600_000, rawTimeout)));
    const initialUrl = this.stage.view.webContents.getURL();
    this.record("login.started", {
      mode,
      profile: this.profile,
      has_username: typeof input.username === "string" && input.username !== "",
      has_password: typeof input.password === "string" && input.password !== "",
    });

    let watchResult: MaloWatchResult | undefined;
    if (mode === "watch") {
      watchResult = await this.watch({ show: true, focus: input.focus === true });
    }

    let attempts = 0;
    let waitReason = "timeout";
    try {
      if (mode === "password") {
        const fields = await this.findLoginFields(input);
        if (fields.username === "" || fields.password === "") {
          waitReason = "login_fields_not_found";
        } else {
          await this.executeAction(
            { type: "fill", selector: fields.username, text: input.username! },
            10_000,
          );
          await this.executeAction(
            { type: "fill", selector: fields.password, text: input.password! },
            10_000,
          );
          if (fields.submit === "") {
            waitReason = "submit_button_not_found";
          } else {
            await this.executeAction({ type: "click", selector: fields.submit }, 10_000);
          }
        }
      }
      if (waitReason !== "login_fields_not_found" && waitReason !== "submit_button_not_found") {
        const waited = await this.waitForLogin(input, initialUrl, timeoutMs);
        attempts = waited.attempts;
        waitReason = waited.reason;
      }
    } catch (error) {
      waitReason = error instanceof Error ? error.message : String(error);
      this.record("login.action_error", { reason: waitReason });
    }

    const ok = waitReason === "success";
    const observation = await this.observe("light", 2_000).catch(() => this.fallbackObservation());
    if (watchResult) {
      if (!ok && input.keep_visible !== true) {
        // Keep a timed-out window visible so the human can continue; hide only after success.
      } else if (ok && input.keep_visible !== true) {
        this.stage.hide();
        watchResult = { ...watchResult, visible: false, window: "hidden" };
      }
    }
    this.record("login.finished", {
      mode,
      ok,
      reason: waitReason,
      final_url: observation.url,
    });
    return {
      mode,
      ok,
      reason: waitReason,
      profile: this.profile,
      final_url: observation.url,
      title: observation.title,
      credentials_used: mode === "password",
      watch: watchResult,
      attempts,
      observation,
    };
  }

  private async findLoginFields(input: MaloLoginInput): Promise<{
    username: string;
    password: string;
    submit: string;
  }> {
    return this.driver.evaluate(`(() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const selectorFor = (el) => {
        if (el.getAttribute("data-demo-id")) return '[data-demo-id="' + CSS.escape(el.getAttribute("data-demo-id")) + '"]';
        if (el.id) return "#" + CSS.escape(el.id);
        const name = el.getAttribute("name");
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const autocomplete = el.getAttribute("autocomplete");
        if (autocomplete) return el.tagName.toLowerCase() + '[autocomplete="' + CSS.escape(autocomplete) + '"]';
        return el.tagName.toLowerCase();
      };
      const pick = (selectors) => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && visible(el)) return selectorFor(el);
        }
        return "";
      };
      const username = ${JSON.stringify(input.username_selector ?? "")} || pick([
        'input[autocomplete="username"]',
        'input[type="email"]',
        'input[name*="user" i]',
        'input[name*="account" i]',
        'input[name*="login" i]',
        'input[id*="user" i]',
        'input[id*="account" i]',
        'input[type="text"]'
      ]);
      const password = ${JSON.stringify(input.password_selector ?? "")} || pick(['input[type="password"]']);
      const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]'))
        .filter(visible);
      const named = buttons.find((el) => /登录|登入|sign in|log in|submit/i.test(el.innerText || el.value || ""));
      const submit = ${JSON.stringify(input.submit_selector ?? "")} || (named ? selectorFor(named) : (buttons[0] ? selectorFor(buttons[0]) : ""));
      return { username, password, submit };
    })()`);
  }

  private async waitForLogin(
    input: MaloLoginInput,
    initialUrl: string,
    timeoutMs: number,
  ): Promise<{ attempts: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const state = await withTimeout(
        this.driver.evaluate<{
          url: string;
          has_password: boolean;
          success: boolean;
          error_selector: boolean;
          error_text: string;
          text: string;
        }>(`(() => {
          const text = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 4000);
          return {
            url: location.href,
            has_password: !!document.querySelector('input[type="password"]'),
            success: ${input.success_selector ? `!!document.querySelector(${JSON.stringify(input.success_selector)})` : "false"},
            error_selector: ${input.error_selector ? `!!document.querySelector(${JSON.stringify(input.error_selector)})` : "false"},
            error_text: (text.match(/密码错误|账号或密码|登录失败|验证码错误|请输入验证码|滑动验证|安全验证|Incorrect|Invalid credentials|Wrong password/i) || [""])[0],
            text
          };
        })()`),
        800,
        "登录状态采样超时",
      ).catch(() => null);
      if (state) {
        if (state.error_selector || state.error_text) {
          return { attempts, reason: "login_error" };
        }
        if (input.success_selector) {
          if (state.success) return { attempts, reason: "success" };
        } else if (input.success_url_contains) {
          if (state.url.includes(input.success_url_contains)) return { attempts, reason: "success" };
        } else if (
          !state.has_password &&
          (state.url !== initialUrl || /退出登录|退出|sign out|log out|dashboard|我的账号/i.test(state.text))
        ) {
          return { attempts, reason: "success" };
        }
      }
      await sleep(250);
    }
    return { attempts, reason: "timeout" };
  }

  private fallbackObservation(): MaloLightObservation {
    const wc = this.stage.view.webContents;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      ready_state: "loading",
      loading: true,
      viewport: { width: 0, height: 0, dpr: 1 },
      dom: { elements: 0, interactive: 0, text_length: 0 },
      body_text: "",
    };
  }

  private async executeAction(action: MaloAction, timeoutMs: number): Promise<string> {
    switch (action.type) {
      case "click": {
        if (action.selector !== undefined && typeof action.selector !== "string") {
          throw new DemoError("E_UNSUPPORTED", "click.selector 必须是字符串");
        }
        const button = action.button ?? "left";
        if (button !== "left" && button !== "middle" && button !== "right") {
          throw new DemoError("E_UNSUPPORTED", "click.button 只能是 left / middle / right");
        }
        const clickCount = action.click_count ?? 1;
        if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
          throw new DemoError("E_UNSUPPORTED", "click.click_count 必须是 1-3 的整数");
        }
        const point = action.selector
          ? await this.driver.rect(action.selector)
          : { x: action.x, y: action.y };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw new DemoError("E_UNSUPPORTED", "click 需要 selector 或 x/y 坐标");
        }
        await this.driver.move({ x: point.x as number, y: point.y as number });
        await this.driver.click(
          { x: point.x as number, y: point.y as number },
          { button, clickCount },
        );
        return `clicked ${action.selector ?? `${point.x},${point.y}`}`;
      }
      case "fill": {
        if (typeof action.selector !== "string" || action.selector.trim() === "") {
          throw new DemoError("E_UNSUPPORTED", "fill.selector 必须是非空字符串");
        }
        if (typeof action.text !== "string") {
          throw new DemoError("E_UNSUPPORTED", "fill.text 必须是字符串");
        }
        const point = await this.driver.rect(action.selector);
        await this.driver.move({ x: point.x, y: point.y });
        await this.driver.click({ x: point.x, y: point.y });
        if (action.clear !== false) {
          await this.driver.selectAll();
          await this.driver.press("Backspace");
        }
        await this.driver.insertText(action.text);
        return `filled ${action.selector} with ${action.text.length} chars`;
      }
      case "press": {
        if (typeof action.key !== "string" || action.key === "") {
          throw new DemoError("E_UNSUPPORTED", "press.key 必须是非空字符串");
        }
        if (!isSupportedKey(action.key)) {
          throw new DemoError(
            "E_UNSUPPORTED",
            `press.key 不支持：${action.key}；可用单字符或 ${[...SUPPORTED_KEY_NAMES].join(" / ")}`,
          );
        }
        if (
          action.modifiers !== undefined &&
          (!Number.isInteger(action.modifiers) || action.modifiers < 0 || action.modifiers > 15)
        ) {
          throw new DemoError("E_UNSUPPORTED", "press.modifiers 必须是 0-15 的整数位掩码");
        }
        await this.driver.press(action.key, action.modifiers ?? 0);
        return `pressed ${action.key}`;
      }
      case "scroll": {
        if (action.dx !== undefined && !Number.isFinite(action.dx)) {
          throw new DemoError("E_UNSUPPORTED", "scroll.dx 必须是有限数字");
        }
        if (action.dy !== undefined && !Number.isFinite(action.dy)) {
          throw new DemoError("E_UNSUPPORTED", "scroll.dy 必须是有限数字");
        }
        await this.driver.scroll({ x: action.dx ?? 0, y: action.dy ?? 0 });
        return `scrolled ${action.dx ?? 0},${action.dy ?? 0}`;
      }
      case "hover": {
        if (action.selector !== undefined && typeof action.selector !== "string") {
          throw new DemoError("E_UNSUPPORTED", "hover.selector 必须是字符串");
        }
        const point = action.selector
          ? await this.driver.rect(action.selector)
          : { x: action.x, y: action.y };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
          throw new DemoError("E_UNSUPPORTED", "hover 需要 selector 或 x/y 坐标");
        }
        await this.driver.move({ x: point.x as number, y: point.y as number });
        return `hovered ${action.selector ?? `${point.x},${point.y}`}`;
      }
      case "select": {
        if (typeof action.selector !== "string" || action.selector.trim() === "") {
          throw new DemoError("E_UNSUPPORTED", "select.selector 必须是非空字符串");
        }
        if (action.value === undefined && action.label === undefined) {
          throw new DemoError("E_UNSUPPORTED", "select 需要 value 或 label");
        }
        const result = await this.driver.evaluate<string>(`(() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return "__MISSING__";
          if (el.tagName !== "SELECT") return "__NOT_SELECT__";
          const value = ${JSON.stringify(action.value ?? null)};
          const label = ${JSON.stringify(action.label ?? null)};
          if (value !== null) {
            if (!Array.from(el.options).some((item) => item.value === value)) return "__NO_VALUE__";
            el.value = value;
          } else {
            const option = Array.from(el.options).find((item) => item.text.trim() === label);
            if (!option) return "__NO_OPTION__";
            el.value = option.value;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return String(el.value);
        })()`);
        if (result === "__MISSING__") {
          throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到元素 ${action.selector}`, {
            selector: action.selector,
          });
        }
        if (result === "__NOT_SELECT__") {
          throw new DemoError("E_UNSUPPORTED", `元素不是 select：${action.selector}`);
        }
        if (result === "__NO_OPTION__") {
          throw new DemoError("E_UNSUPPORTED", `找不到选项 label：${action.label}`);
        }
        if (result === "__NO_VALUE__") {
          throw new DemoError("E_UNSUPPORTED", `找不到选项 value：${action.value}`);
        }
        return `selected ${action.selector}=${result}`;
      }
      case "focus": {
        if (typeof action.selector !== "string" || action.selector.trim() === "") {
          throw new DemoError("E_UNSUPPORTED", "focus.selector 必须是非空字符串");
        }
        const focused = await this.driver.evaluate<boolean>(`(() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return false;
          el.focus();
          return document.activeElement === el;
        })()`);
        if (!focused) {
          throw new DemoError("E_SELECTOR_NOT_FOUND", `无法聚焦元素 ${action.selector}`, {
            selector: action.selector,
          });
        }
        return `focused ${action.selector}`;
      }
      case "scroll_into_view": {
        if (typeof action.selector !== "string" || action.selector.trim() === "") {
          throw new DemoError("E_UNSUPPORTED", "scroll_into_view.selector 必须是非空字符串");
        }
        const scrolled = await this.driver.evaluate<boolean>(`(() => {
          const el = document.querySelector(${JSON.stringify(action.selector)});
          if (!el) return false;
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          return true;
        })()`);
        if (!scrolled) {
          throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到元素 ${action.selector}`, {
            selector: action.selector,
          });
        }
        return `scrolled into view ${action.selector}`;
      }
      case "history": {
        if (action.action !== "back" && action.action !== "forward" && action.action !== "reload") {
          throw new DemoError("E_UNSUPPORTED", "history.action 只能是 back / forward / reload");
        }
        const wc = this.stage.view.webContents;
        if (action.action === "back") wc.goBack();
        else if (action.action === "forward") wc.goForward();
        else wc.reload();
        await sleep(300);
        return `history ${action.action}`;
      }
      case "wait_for": {
        if (action.timeout_ms !== undefined && (!Number.isFinite(action.timeout_ms) || action.timeout_ms < 0)) {
          throw new DemoError("E_UNSUPPORTED", "wait_for.timeout_ms 必须是非负数字");
        }
        if (action.selector) {
          const state = action.state ?? "visible";
          if (state !== "attached" && state !== "visible" && state !== "hidden") {
            throw new DemoError("E_UNSUPPORTED", "wait_for.state 只能是 attached / visible / hidden");
          }
          await this.driver.waitForSelector(action.selector, state, action.timeout_ms ?? timeoutMs);
          return `selector ${state}: ${action.selector}`;
        }
        if (action.text) {
          await this.driver.waitForText(action.text, action.timeout_ms ?? timeoutMs);
          return `text appeared: ${action.text}`;
        }
        throw new DemoError("E_UNSUPPORTED", "wait_for 需要 selector 或 text");
      }
      case "sleep": {
        if (!Number.isFinite(action.ms) || action.ms < 0 || action.ms > 120_000) {
          throw new DemoError("E_UNSUPPORTED", "sleep.ms 必须是 0-120000 的毫秒数");
        }
        await sleep(action.ms);
        return `slept ${action.ms}ms`;
      }
      default: {
        const unknown = action as { type?: string };
        throw new DemoError("E_UNSUPPORTED", `未知动作：${unknown.type ?? ""}`);
      }
    }
  }

  eventsAfter(after: number, limit = 100): MaloSessionEvent[] {
    const bounded = Math.max(1, Math.min(MAX_EVENT_LOG, Math.floor(limit)));
    return this.events.filter((event) => event.seq > after).slice(0, bounded);
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
    this.eventSeq += 1;
    this.events.push({
      seq: this.eventSeq,
      at: new Date().toISOString(),
      type,
      detail,
    });
    if (this.events.length > (this.options.eventLimit ?? MAX_EVENT_LOG)) {
      this.events.splice(0, this.events.length - (this.options.eventLimit ?? MAX_EVENT_LOG));
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.record("session.closed", { profile: this.profile });
    this.detachHooks?.();
    this.detachHooks = null;
    const wc = this.stage.view.webContents;
    if (this.profile === null) {
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
  }

  private abortCreate(): void {
    if (this.closed) return;
    this.closed = true;
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

  private async assertValidSelector(selector: string): Promise<void> {
    const error = await this.driver.evaluate<string | null>(`(() => {
      try { document.querySelector(${JSON.stringify(selector)}); return null; }
      catch (error) { return String((error && error.message) || error); }
    })()`);
    if (error !== null) {
      throw new DemoError("E_BAD_REQUEST", `选择器语法错误：${error}`);
    }
  }

  private async captureFailure(): Promise<string | null> {
    try {
      const target = path.join(this.artifactsDir, `failure-${Date.now()}.png`);
      await this.driver.screenshot(target);
      return target;
    } catch {
      return null;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new DemoError("E_SESSION_NOT_FOUND", `session 已关闭：${this.id}`);
  }
}
