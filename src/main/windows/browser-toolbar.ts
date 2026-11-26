import path from "node:path";
import { WebContentsView, ipcMain } from "electron";
import {
  normalizeAddress,
  type BrowserToolbarNavigateResult,
  type BrowserToolbarState,
  type HumanPanelState,
} from "../../shared/toolbar";
import type { HumanSignal } from "../malo/human-signals";

export const TOOLBAR_HEIGHT = 44;

const CHANNELS = {
  navigate: "toolbar:navigate",
  back: "toolbar:back",
  forward: "toolbar:forward",
  reload: "toolbar:reload",
  state: "toolbar:state",
  human: "human:state",
} as const;

// 人给 agent 发的信号：完成 / 暂停 / 继续 / 停止
const SIGNAL_CHANNELS = {
  done: "human:done",
  pause: "human:pause",
  resume: "human:resume",
  stop: "human:stop",
} as const;

const PRELOAD_PATH = path.join(__dirname, "../../preload/browser-toolbar.js");

const toolbars = new Map<number, BrowserToolbar>();
let ipcWired = false;

function wireIpc(): void {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.handle(CHANNELS.navigate, (event, input: unknown) => {
    const toolbar = toolbars.get(event.sender.id);
    if (!toolbar) return { ok: false, error: "工具栏已关闭" } satisfies BrowserToolbarNavigateResult;
    return toolbar.navigate(typeof input === "string" ? input : "");
  });
  ipcMain.handle(CHANNELS.back, (event) => toolbars.get(event.sender.id)?.back());
  ipcMain.handle(CHANNELS.forward, (event) => toolbars.get(event.sender.id)?.forward());
  ipcMain.handle(CHANNELS.reload, (event) => toolbars.get(event.sender.id)?.reload());
  for (const [signal, channel] of Object.entries(SIGNAL_CHANNELS) as [HumanSignal, string][]) {
    ipcMain.handle(channel, (event) => toolbars.get(event.sender.id)?.humanSignal(signal));
  }
}

export class BrowserToolbar {
  readonly view: WebContentsView;
  private readonly page: WebContentsView;
  private readonly onHumanSignal?: (signal: HumanSignal) => void;
  private human: HumanPanelState = { done: false, paused: false, stopped: false };

  constructor(
    page: WebContentsView,
    options: { onHumanSignal?: (signal: HumanSignal) => void } = {},
  ) {
    wireIpc();
    this.page = page;
    this.onHumanSignal = options.onHumanSignal;
    this.view = new WebContentsView({
      webPreferences: {
        preload: PRELOAD_PATH,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: "malo-toolbar",
      },
    });
    toolbars.set(this.view.webContents.id, this);
    this.watchPage();
    this.view.webContents.on("did-finish-load", () => {
      this.pushState();
      this.pushHuman();
    });
    void this.view.webContents.loadURL(toolbarDataUrl());
  }

  /** 人在工具条上点了完成 / 暂停 / 继续 / 停止。 */
  humanSignal(signal: HumanSignal): void {
    this.onHumanSignal?.(signal);
  }

  /** 会话把当前的人机状态同步到工具条（按钮可用性、暂停/继续的切换）。 */
  setHuman(state: HumanPanelState): void {
    this.human = { ...state };
    this.pushHuman();
  }

  private pushHuman(): void {
    const toolbar = this.view.webContents;
    if (!toolbar || toolbar.isDestroyed()) return;
    toolbar.send(CHANNELS.human, this.human);
  }

  layout(width: number, height: number): void {
    const view = this.view.webContents;
    if (!view || view.isDestroyed()) return;
    this.view.setBounds({ x: 0, y: 0, width, height: Math.min(TOOLBAR_HEIGHT, height) });
  }

  async navigate(input: string): Promise<BrowserToolbarNavigateResult> {
    const target = normalizeAddress(input);
    if (!target) return { ok: false, error: "只支持 http/https 地址" };
    try {
      await this.page.webContents.loadURL(target);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  back(): void {
    const wc = this.page.webContents;
    if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  }

  forward(): void {
    const wc = this.page.webContents;
    if (!wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  }

  reload(): void {
    const wc = this.page.webContents;
    if (!wc.isDestroyed()) wc.reload();
  }

  destroy(): void {
    // BrowserView 销毁后 .webContents 是 undefined（不是 destroyed 对象），
    // 先判空再操作；同时摘掉页面事件监听，避免销毁竞态窗口里再进 pushState。
    const view = this.view.webContents;
    if (view) toolbars.delete(view.id);
    const wc = this.page.webContents;
    if (wc) {
      wc.removeListener("did-navigate", this.push);
      wc.removeListener("did-navigate-in-page", this.push);
      wc.removeListener("did-start-loading", this.push);
      wc.removeListener("did-stop-loading", this.push);
      wc.removeListener("did-fail-load", this.push);
      wc.removeListener("page-title-updated", this.push);
    }
    if (view && !view.isDestroyed()) view.close();
  }

  private readonly push = (): void => this.pushState();

  private watchPage(): void {
    const wc = this.page.webContents;
    wc.on("did-navigate", this.push);
    wc.on("did-navigate-in-page", this.push);
    wc.on("did-start-loading", this.push);
    wc.on("did-stop-loading", this.push);
    wc.on("did-fail-load", this.push);
    wc.on("page-title-updated", this.push);
  }

  private pushState(): void {
    const toolbar = this.view.webContents;
    if (!toolbar || toolbar.isDestroyed()) return;
    const wc = this.page.webContents;
    if (!wc || wc.isDestroyed()) return;
    const state: BrowserToolbarState = {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
    };
    toolbar.send(CHANNELS.state, state);
  }
}

function toolbarDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(TOOLBAR_HTML)}`;
}

const TOOLBAR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Malo toolbar</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; gap: 4px;
    padding: 0 10px; background: #f4f5f7;
    border-bottom: 1px solid #e3e6ea;
    font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #1f242c; user-select: none; overflow: hidden;
  }
  button {
    width: 28px; height: 28px; flex: none;
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; border-radius: 6px; background: transparent; color: #3d4550;
    cursor: default; padding: 0;
  }
  button:hover:not(:disabled) { background: #e6e9ee; }
  button:active:not(:disabled) { background: #dbe0e7; }
  button:disabled { color: #b7bdc7; }
  button svg { width: 16px; height: 16px; }
  button svg.spinning { animation: spin .9s linear infinite; }
  input {
    flex: 1 1 auto; min-width: 90px; height: 28px;
    margin-left: 4px; padding: 0 10px;
    border: 1px solid #d8dce3; border-radius: 7px;
    background: #ffffff; color: #1f242c;
    font: inherit; font-size: 12.5px;
  }
  input:focus { outline: none; border-color: #7fa3ff; box-shadow: 0 0 0 3px rgba(90, 140, 255, .16); }
  input.invalid { border-color: #e07a7a; box-shadow: 0 0 0 3px rgba(224, 122, 122, .16); }
  .human { display: inline-flex; align-items: center; gap: 4px; flex: none; margin-left: 8px; padding-left: 8px; border-left: 1px solid #e3e6ea; }
  .human .state { min-width: 0; font-size: 12px; color: #6b7280; white-space: nowrap; }
  .human .state.on { color: #1f242c; }
  button.signal { width: auto; padding: 0 8px; font-size: 12px; }
  button.signal.stop { color: #b42318; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <button id="back" title="后退" aria-label="后退">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
  </button>
  <button id="forward" title="前进" aria-label="前进">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
  </button>
  <button id="reload" title="刷新" aria-label="刷新">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>
  </button>
  <input id="address" spellcheck="false" autocomplete="off" placeholder="输入网址，回车打开" />
  <span class="human" title="这里是你和 agent 的交接：做完点「完成」，不想让它继续动页面就点「暂停」或「停止」">
    <span id="human-state" class="state"></span>
    <button id="human-done" class="signal" title="告诉 agent：我做完了，可以继续">完成</button>
    <button id="human-pause" class="signal" title="暂停期间 agent 不能操作这个页面">暂停</button>
    <button id="human-stop" class="signal stop" title="让 agent 停手：它不能再操作这个页面">停止</button>
  </span>
<script>
  const api = window.maloToolbar;
  const address = document.getElementById("address");
  const back = document.getElementById("back");
  const forward = document.getElementById("forward");
  const reload = document.getElementById("reload");
  const reloadIcon = reload.querySelector("svg");
  let currentUrl = "";
  const humanState = document.getElementById("human-state");
  const doneButton = document.getElementById("human-done");
  const pauseButton = document.getElementById("human-pause");
  const stopButton = document.getElementById("human-stop");
  let paused = false;

  back.addEventListener("click", () => api.back());
  forward.addEventListener("click", () => api.forward());
  reload.addEventListener("click", () => api.reload());
  doneButton.addEventListener("click", () => api.done());
  pauseButton.addEventListener("click", () => api[paused ? "resume" : "pause"]());
  stopButton.addEventListener("click", () => api.stop());

  address.addEventListener("focus", () => address.select());
  address.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = (address.value || "").trim();
      if (value === "") return;
      api.navigate(value).then((result) => {
        if (result && result.ok === false) {
          address.classList.add("invalid");
          setTimeout(() => address.classList.remove("invalid"), 1200);
          return;
        }
        address.blur();
      });
    } else if (event.key === "Escape") {
      address.value = currentUrl;
      address.blur();
    }
  });
  address.addEventListener("blur", () => {
    address.classList.remove("invalid");
    if (currentUrl) address.value = currentUrl;
  });

  api.onHuman((state) => {
    paused = state.paused;
    pauseButton.textContent = state.paused ? "继续" : "暂停";
    doneButton.disabled = state.done || state.stopped;
    pauseButton.disabled = state.stopped;
    stopButton.disabled = state.stopped;
    humanState.textContent = state.stopped ? "已停止" : state.paused ? "已暂停" : state.done ? "已完成" : "";
    humanState.classList.toggle("on", state.stopped || state.paused || state.done);
  });

  api.onState((state) => {
    currentUrl = state.url || "";
    if (document.activeElement !== address) address.value = currentUrl;
    back.disabled = !state.canGoBack;
    forward.disabled = !state.canGoForward;
    reloadIcon.classList.toggle("spinning", Boolean(state.loading));
  });

</script>
</body>
</html>`;
