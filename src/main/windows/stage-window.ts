import { BaseWindow, WebContentsView, screen } from "electron";
import type { WindowMode } from "../../shared/types";
import type { HumanPanelState } from "../../shared/toolbar";
import { BrowserToolbar, TOOLBAR_HEIGHT } from "./browser-toolbar";
import { dockPresenceHidden, dockPresenceShown } from "./dock-presence";
import type { HumanSignal } from "../malo/human-signals";

export type StageOptions = {
  width: number;
  height: number;
  showMode: WindowMode;
  displayId?: number;
  fullscreen?: boolean;
  partition?: string;
  title?: string;
  frame?: boolean;
  toolbar?: boolean;
  /**
   * 窗口被人关掉（红色关闭钮）后的回调。给了回调的舞台，关窗后会立刻换一个隐藏窗口
   * 接着托管同一个页面视图：会话不随窗口结束，下次显示时页面原样还在。
   */
  onWindowClosed?: () => void;
  /** 人在工具条上点了完成 / 暂停 / 继续 / 停止。 */
  onHumanSignal?: (signal: HumanSignal) => void;
};

export class StageWindow {
  readonly view: WebContentsView;
  private host: BaseWindow;
  private bar: BrowserToolbar | null = null;
  private readonly options: StageOptions;
  private pageWidth: number;
  private pageHeight: number;
  private placed = false;
  private closing = false;

  constructor(options: StageOptions) {
    this.options = options;
    this.pageWidth = options.width;
    this.pageHeight = options.height;
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: options.partition ?? "persist:demo-stage",
      },
    });
    this.host = this.createWindow();
    // 一创建就给人看的窗口立刻带工具条；隐藏窗口等到第一次 showForHuman 再建。
    if (options.toolbar && options.showMode !== "hidden") this.ensureToolbar();
    this.layout();
    if (options.displayId !== undefined) this.moveToDisplay(options.displayId);
    if (options.showMode !== "hidden") this.show(options.showMode);
    if (options.fullscreen) this.host.setFullScreen(true);
  }

  // width/height are the page viewport; the window adds the toolbar height on top.
  get window(): BaseWindow {
    return this.host;
  }

  get toolbar(): BrowserToolbar | null {
    return this.bar;
  }

  private get toolbarHeight(): number {
    return this.bar ? TOOLBAR_HEIGHT : 0;
  }

  private createWindow(): BaseWindow {
    const window = new BaseWindow({
      width: this.pageWidth,
      height: this.pageHeight + this.toolbarHeight,
      useContentSize: true,
      show: false,
      frame: this.options.frame !== false,
      backgroundColor: "#ffffff",
      title: this.options.title ?? "Demo Stage",
    });
    window.contentView.addChildView(this.view);
    if (this.bar) window.contentView.addChildView(this.bar.view);
    window.on("resize", this.layout);
    window.on("closed", this.onClosed);
    return window;
  }

  private pageAlive(): boolean {
    const wc = this.view.webContents;
    return wc !== undefined && !wc.isDestroyed();
  }

  private readonly onClosed = (): void => {
    if (this.closing || !this.options.onWindowClosed) return;
    // 页面已经不在（被外部销毁）：没有东西可以换窗续活，按关窗处理
    if (!this.pageAlive()) {
      this.closing = true;
      return;
    }
    this.host = this.createWindow();
    this.placed = false;
    this.layout();
    this.options.onWindowClosed();
  };

  private ensureWindow(): BaseWindow {
    if (!this.host.isDestroyed()) return this.host;
    if (!this.pageAlive()) throw new Error("stage 的页面已销毁，无法再创建窗口托管它");
    this.host = this.createWindow();
    this.layout();
    return this.host;
  }

  /** 把人机状态同步到工具条（按钮可用性、暂停/继续）。 */
  setHumanState(state: HumanPanelState): void {
    this.bar?.setHuman(state);
  }

  /** 工具条按需创建：agent 驱动的隐藏会话不为它多养一个渲染进程。 */
  ensureToolbar(): BrowserToolbar | null {
    if (!this.options.toolbar || this.bar) return this.bar;
    this.bar = new BrowserToolbar(this.view, { onHumanSignal: this.options.onHumanSignal });
    const window = this.host;
    if (window.isDestroyed()) return this.bar;
    window.contentView.addChildView(this.bar.view);
    // 页面视口不变：长出来的 44 是工具条，窗口内容区跟着长高
    window.setContentSize(this.pageWidth, this.pageHeight + TOOLBAR_HEIGHT, false);
    this.layout();
    return this.bar;
  }

  show(mode: Exclude<WindowMode, "hidden">): void {
    const window = this.ensureWindow();
    if (mode === "offscreen") window.setPosition(-12000, -12000, false);
    if (mode === "ghost") window.setOpacity(0);
    if (mode === "focused") window.show();
    else window.showInactive();
    if (mode === "inactive" || mode === "focused") dockPresenceShown(window);
    else dockPresenceHidden(window);
  }

  showForHuman(mode: "inactive" | "focused"): void {
    this.ensureToolbar();
    const window = this.ensureWindow();
    // 每个窗口只在第一次显示时摆到工作区正中；之后位置归人管（拖动过的不被拉回来）。
    if (!this.placed) {
      const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
      const bounds = window.getBounds();
      window.setPosition(
        x + Math.max(0, Math.round((width - bounds.width) / 2)),
        y + Math.max(0, Math.round((height - bounds.height) / 2)),
        false,
      );
      this.placed = true;
    }
    this.show(mode);
  }

  hide(): void {
    if (!this.host.isDestroyed()) this.host.hide();
    dockPresenceHidden(this.host);
  }

  isVisible(): boolean {
    return !this.host.isDestroyed() && this.host.isVisible();
  }

  resize(width: number, height: number): void {
    this.pageWidth = width;
    this.pageHeight = height;
    if (this.host.isDestroyed()) return;
    this.host.setContentSize(width, height + this.toolbarHeight, false);
    this.layout();
  }

  private readonly layout = (): void => {
    const window = this.host;
    if (window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    this.bar?.layout(width, height);
    this.view.setBounds({
      x: 0,
      y: this.toolbarHeight,
      width,
      height: Math.max(0, height - this.toolbarHeight),
    });
  };

  moveToDisplay(displayId: number): void {
    const display = screen.getAllDisplays().find((item) => item.id === displayId);
    if (!display) throw new Error(`找不到显示器 ${displayId}`);
    const { x, y } = display.bounds;
    this.host.setPosition(x, y, false);
  }

  setFullscreen(on: boolean): void {
    this.host.setFullScreen(on);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    dockPresenceHidden(this.host);
    this.bar?.destroy();
    this.bar = null;
    // 窗口关掉不会带走页面：视图还挂着渲染进程，必须显式关掉，否则活到进程退出
    const wc = this.view.webContents;
    if (wc !== undefined && !wc.isDestroyed()) wc.close();
    if (!this.host.isDestroyed()) this.host.destroy();
  }
}
