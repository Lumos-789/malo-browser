import { ipcMain, shell } from "electron";
import type { ControlCommand } from "../shared/types";
import { DemoError } from "../shared/errors";
import type { AppController } from "./app-controller";
import type { DirectorWindow } from "./windows/director-window";
import { DIRECTOR_CHANNELS } from "../preload/director-api";
import { dispatchCommand } from "./control-dispatch";

export function wireIpc(controller: AppController, director: DirectorWindow): void {
  controller.onEvent((event) => director.send(DIRECTOR_CHANNELS.event, event));

  ipcMain.handle(DIRECTOR_CHANNELS.getSnapshot, () => controller.directorSnapshot());
  ipcMain.handle(DIRECTOR_CHANNELS.send, (_event, command: ControlCommand) =>
    dispatchCommand(controller, command),
  );
  ipcMain.handle(DIRECTOR_CHANNELS.openPath, async (_event, target: string) => {
    const result = await shell.openPath(target);
    if (result) throw new DemoError("E_UNSUPPORTED", `打开路径失败：${result}`);
  });

  director.window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const meta = input.meta;
    const alt = input.alt;
    if (!meta || !alt) return;
    const key = input.key;
    if (key === "ArrowRight") void controller.next();
    else if (key === "ArrowLeft") void controller.prev();
    else if (key === " ") void controller.pause();
    else if (key.toLowerCase() === "b") void controller.blackout(!controller.snapshot().stage.blackout);
    else if (key.toLowerCase() === "f")
      void controller.setFullscreen(!controller.snapshot().stage.fullscreen);
    else if (key.toLowerCase() === "r") {
      const status = controller.snapshot().recorder.status;
      void (status === "recording" ? controller.recordStop() : controller.recordStart());
    } else {
      return;
    }
    event.preventDefault();
  });
}
