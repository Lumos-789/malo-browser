import { app } from "electron";
import path from "node:path";
import { AppController } from "./app-controller";
import { wireIpc } from "./ipc";
import { DirectorWindow } from "./windows/director-window";
import { startControlServer } from "./control";
import { dispatchCommand } from "./control-dispatch";
import { controlApiTokenHint } from "./tools";

export type AppLaunchOptions = {
  scenesRoot: string;
  outputRoot: string;
  windowMode: "hidden" | "inactive" | "offscreen" | "ghost" | "focused";
  showStage: boolean;
  autorun?: string | null;
  directorCheck?: boolean;
  controlApi?: boolean;
  controlPort?: number;
  headless?: boolean;
};

export async function launchApp(options: AppLaunchOptions): Promise<AppController> {
  const scenesRoot = path.resolve(options.scenesRoot);
  const outputRoot = path.resolve(options.outputRoot);

  const controller = new AppController({
    scenesRoot,
    outputRoot,
    windowMode: options.windowMode,
  });
  await controller.init();

  if (options.controlApi) {
    const recordFile = path.join(outputRoot, "control.json");
    const server = await startControlServer({
      send: (command) => dispatchCommand(controller, command),
      getSnapshot: () => controller.directorSnapshot(),
      onEvent: (listener) => controller.onEvent(listener),
      port: options.controlPort,
      recordFile,
    });
    console.error(`[malo-browser] control api ${server.url}`);
    console.error(`[malo-browser] ${controlApiTokenHint(recordFile)}`);
    app.on("will-quit", () => {
      void server.close();
    });
  }

  if (options.autorun) {
    const offEvents = controller.onEvent((event) => {
      if (event.type === "scene.ready") console.error(`[malo-browser] 场景就绪 ${event.sceneId}`);
      else if (event.type === "recorder.started") console.error(`[malo-browser] 录制开始 → ${event.outputPath}`);
      else if (event.type === "step.completed")
        console.error(`[malo-browser] 步骤 ${event.index + 1} ${event.id} ✓ ${Math.round(event.durationMs)}ms`);
      else if (event.type === "step.failed")
        console.error(`[malo-browser] 步骤 ${event.index + 1} ${event.id} ✗ ${event.message}`);
      else if (event.type === "run.completed") console.error(`[malo-browser] 场景跑完 ${event.stepTotal} 步`);
      else if (event.type === "recorder.stopped") console.error(`[malo-browser] 录制结束 ${event.frames} 帧`);
    });
    try {
      await controller.loadScene(options.autorun);
      await controller.recordStart();
      let runFailure: unknown = null;
      try {
        await controller.start("record");
      } catch (error) {
        runFailure = error;
      }
      // A failed step still stops the recorder so the take keeps its video and failed evidence.
      console.error("[malo-browser] 交互结束，编码中…");
      try {
        await controller.recordStop();
      } catch (error) {
        if (runFailure === null) throw error;
        console.error(`[malo-browser] 录制收尾失败：${(error as Error).message}`);
      }
      if (runFailure !== null) throw runFailure;
    } finally {
      offEvents();
    }
    return controller;
  }

  const director = new DirectorWindow({
    preloadPath: path.join(__dirname, "../preload/index.js"),
    rendererPath: path.join(app.getAppPath(), "out/director"),
    show: !(options.directorCheck || options.headless),
  });
  wireIpc(controller, director);

  if (options.directorCheck) {
    await new Promise<void>((resolve) => director.window.webContents.once("did-finish-load", () => resolve()));
    const probe = await director.window.webContents.executeJavaScript(
      `(async () => {
        if (!window.demoStage) {
          return { api: "undefined", mockBadge: document.body.innerText.includes("MOCK") };
        }
        const snapshot = await window.demoStage.getSnapshot();
        return {
          api: typeof window.demoStage,
          scenes: snapshot.scenes ? snapshot.scenes.length : 0,
          status: snapshot.run ? snapshot.run.status : null,
          mockBadge: document.body.innerText.includes("MOCK"),
        };
      })()`,
    );
    console.log(JSON.stringify({ director: probe }));
  }
  director.window.on("closed", () => controller.dispose());
  return controller;
}
