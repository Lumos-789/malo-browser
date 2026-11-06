import path from "node:path";
import { WebContentsView, ipcMain } from "electron";
import {
  normalizeAddress,
  type BrowserToolbarNavigateResult,
  type BrowserToolbarState,
} from "../../shared/toolbar";

export const TOOLBAR_HEIGHT = 44;

const CHANNELS = {
  navigate: "toolbar:navigate",
  back: "toolbar:back",
  forward: "toolbar:forward",
  reload: "toolbar:reload",
  state: "toolbar:state",
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
}

export class BrowserToolbar {
  readonly view: WebContentsView;
  private readonly page: WebContentsView;

  constructor(page: WebContentsView) {
    wireIpc();
    this.page = page;
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
    this.view.webContents.on("did-finish-load", () => this.pushState());
    void this.view.webContents.loadURL(toolbarDataUrl());
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
<script>
  const api = window.maloToolbar;
  const address = document.getElementById("address");
  const back = document.getElementById("back");
  const forward = document.getElementById("forward");
  const reload = document.getElementById("reload");
  const reloadIcon = reload.querySelector("svg");
  let currentUrl = "";

  back.addEventListener("click", () => api.back());
  forward.addEventListener("click", () => api.forward());
  reload.addEventListener("click", () => api.reload());

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
