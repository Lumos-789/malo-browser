import type { ControlCommand } from "../shared/types";
import { DemoError } from "../shared/errors";
import type { AppController } from "./app-controller";

export const SUPPORTED_COMMANDS: Record<ControlCommand["cmd"], true> = {
  "scene.load": true,
  "run.start": true,
  "run.next": true,
  "run.prev": true,
  "run.pause": true,
  "run.resume": true,
  "run.reset": true,
  "stage.blackout": true,
  "stage.fullscreen": true,
  "stage.display": true,
  "recorder.start": true,
  "recorder.stop": true,
};

/**
 * Single entry point for every control surface (IPC today, local HTTP next).
 * Both must drive the same AppController so state cannot fork per transport.
 */
export async function dispatchCommand(
  controller: AppController,
  command: ControlCommand,
): Promise<unknown> {
  switch (command.cmd) {
    case "scene.load":
      return controller.loadScene(command.args.sceneId);
    case "run.start":
      return controller.start(command.args.mode);
    case "run.next":
      return controller.next();
    case "run.prev":
      return controller.prev();
    case "run.pause":
      controller.pause();
      return null;
    case "run.resume":
      return controller.resume();
    case "run.reset":
      return controller.reset();
    case "stage.blackout":
      return controller.blackout(command.args.on);
    case "stage.fullscreen":
      return controller.setFullscreen(command.args.on);
    case "stage.display":
      return controller.moveToDisplay(command.args.displayId);
    case "recorder.start":
      return controller.recordStart(command.args.output);
    case "recorder.stop":
      return controller.recordStop();
    default: {
      const unknown = command as { cmd?: string };
      const commands = Object.keys(SUPPORTED_COMMANDS).join("、");
      throw new DemoError("E_UNSUPPORTED", `未知命令 ${unknown.cmd ?? ""}，可用命令：${commands}`);
    }
  }
}
