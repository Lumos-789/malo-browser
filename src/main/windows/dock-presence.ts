import { app, type BaseWindow } from "electron";

// daemon 以 accessory 策略运行，纯后台时 Dock 无图标；但人眼可见的窗口必须找得回来：
// 有可见窗口期间亮出 Dock 图标（用户点它才把窗口调前，进程自身从不 activate），
// 窗口全部收起后图标自动隐藏。
let dynamic = false;
let activateHooked = false;
let dockIconShown = false;
const visible = new Set<BaseWindow>();

function syncDock(): void {
  const dock = app.dock;
  if (!dock) return;
  for (const window of visible) {
    if (window.isDestroyed()) visible.delete(window);
  }
  if (visible.size > 0 && !dockIconShown) {
    dockIconShown = true;
    void Promise.resolve(dock.show()).catch(() => undefined);
  } else if (visible.size === 0 && dockIconShown) {
    dockIconShown = false;
    dock.hide();
  }
}

export function initDockPresence(options: { dynamic: boolean }): void {
  dynamic = options.dynamic && app.dock !== undefined;
  if (!dynamic || activateHooked) return;
  activateHooked = true;
  app.on("activate", () => {
    for (const window of visible) {
      if (!window.isDestroyed()) window.focus();
    }
  });
}

export function dockPresenceShown(window: BaseWindow): void {
  if (!dynamic || window.isDestroyed()) return;
  if (!visible.has(window)) {
    visible.add(window);
    window.once("closed", () => dockPresenceHidden(window));
  }
  syncDock();
}

export function dockPresenceHidden(window: BaseWindow): void {
  if (!dynamic) return;
  if (!visible.delete(window)) return;
  syncDock();
}
