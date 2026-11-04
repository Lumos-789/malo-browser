import { BaseWindow, WebContentsView } from "electron";

export type ShowMode = "hidden" | "inactive" | "offscreen" | "ghost" | "focused";

export type Stage = {
  window: BaseWindow;
  view: WebContentsView;
  showMode: ShowMode;
  close(): void;
};

export function createStage(options: {
  width: number;
  height: number;
  showMode: ShowMode;
}): Stage {
  const window = new BaseWindow({
    width: options.width,
    height: options.height,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: "#ffffff",
    title: "Malo Browser Stage",
  });

  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      partition: "persist:malo-browser-spike",
    },
  });

  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: options.width, height: options.height });

  if (options.showMode === "inactive" || options.showMode === "offscreen" || options.showMode === "ghost") {
    window.showInactive();
  } else if (options.showMode === "focused") {
    window.show();
  }
  if (options.showMode === "offscreen") {
    window.setPosition(-12000, -12000, false);
  }
  if (options.showMode === "ghost") {
    window.setOpacity(0);
  }

  return {
    window,
    view,
    showMode: options.showMode,
    close() {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
