import { BaseWindow, WebContentsView, screen } from "electron";
import type { WindowMode } from "../../shared/types";
import { BrowserToolbar, TOOLBAR_HEIGHT } from "./browser-toolbar";

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
};

export class StageWindow {
  readonly window: BaseWindow;
  readonly view: WebContentsView;
  readonly toolbar?: BrowserToolbar;
  // width/height are the page viewport; the window adds the toolbar height on top.
  private readonly toolbarHeight: number;

  constructor(options: StageOptions) {
    this.toolbarHeight = options.toolbar ? TOOLBAR_HEIGHT : 0;
    this.window = new BaseWindow({
      width: options.width,
      height: options.height + this.toolbarHeight,
      useContentSize: true,
      show: false,
      frame: options.frame === true,
      backgroundColor: "#ffffff",
      title: options.title ?? "Demo Stage",
    });
    this.view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: options.partition ?? "persist:demo-stage",
      },
    });
    this.window.contentView.addChildView(this.view);
    if (options.toolbar) {
      this.toolbar = new BrowserToolbar(this.view);
      this.window.contentView.addChildView(this.toolbar.view);
    }
    this.layout(options.width, options.height + this.toolbarHeight);
    this.window.on("resize", () => {
      if (this.window.isDestroyed()) return;
      const { width, height } = this.window.getContentBounds();
      this.layout(width, height);
    });

    if (options.displayId !== undefined) this.moveToDisplay(options.displayId);
    if (options.showMode !== "hidden") this.show(options.showMode);
    if (options.fullscreen) this.window.setFullScreen(true);
  }

  show(mode: Exclude<WindowMode, "hidden">): void {
    if (mode === "focused") this.window.show();
    else this.window.showInactive();
    if (mode === "offscreen") this.window.setPosition(-12000, -12000, false);
    if (mode === "ghost") this.window.setOpacity(0);
  }

  showForHuman(mode: "inactive" | "focused"): void {
    if (this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    this.window.setPosition(
      x + Math.max(0, Math.round((width - bounds.width) / 2)),
      y + Math.max(0, Math.round((height - bounds.height) / 2)),
      false,
    );
    if (mode === "focused") this.window.show();
    else this.window.showInactive();
  }

  hide(): void {
    if (!this.window.isDestroyed()) this.window.hide();
  }

  isVisible(): boolean {
    return !this.window.isDestroyed() && this.window.isVisible();
  }

  resize(width: number, height: number): void {
    if (this.window.isDestroyed()) return;
    this.window.setContentSize(width, height + this.toolbarHeight, false);
    this.layout(width, height + this.toolbarHeight);
  }

  private layout(width: number, height: number): void {
    this.toolbar?.layout(width, height);
    this.view.setBounds({
      x: 0,
      y: this.toolbarHeight,
      width,
      height: Math.max(0, height - this.toolbarHeight),
    });
  }

  moveToDisplay(displayId: number): void {
    const display = screen.getAllDisplays().find((item) => item.id === displayId);
    if (!display) throw new Error(`找不到显示器 ${displayId}`);
    const { x, y } = display.bounds;
    this.window.setPosition(x, y, false);
  }

  setFullscreen(on: boolean): void {
    this.window.setFullScreen(on);
  }

  close(): void {
    this.toolbar?.destroy();
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
