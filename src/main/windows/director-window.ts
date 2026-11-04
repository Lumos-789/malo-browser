import { BrowserWindow } from "electron";
import path from "node:path";

export type DirectorOptions = {
  preloadPath: string;
  rendererPath: string;
  width?: number;
  height?: number;
  show?: boolean;
};

export class DirectorWindow {
  readonly window: BrowserWindow;

  constructor(options: DirectorOptions) {
    this.window = new BrowserWindow({
      width: options.width ?? 1180,
      height: options.height ?? 720,
      minWidth: 920,
      minHeight: 600,
      title: "Malo Browser · Director",
      show: options.show ?? true,
      backgroundColor: "#0f1419",
      webPreferences: {
        preload: options.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    void this.window.loadFile(path.join(options.rendererPath, "index.html"));
  }

  send(channel: string, payload: unknown): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, payload);
  }

  close(): void {
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}
