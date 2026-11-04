import path from "node:path";
import { app, Menu, protocol } from "electron";
import { isHelpRequested, isVersionRequested, parseOptions, USAGE, type Options } from "./cli";
import { runPhase0 } from "./phase0";
import { launchApp } from "./app";
import { launchMaloDaemon, type MaloDaemon } from "./malo";

function debug(message: string): void {
  if (process.env.DEMO_DEBUG) console.error(`[malo-browser] ${message}`);
}

function exitCodeFor(error: unknown): number {
  const message = (error as Error)?.message ?? String(error);
  if (message.includes("E_FFMPEG") || message.includes("ffmpeg") || message.includes("ffprobe")) return 3;
  if (message.includes("E_RECORDER")) return 4;
  return 2;
}

function fatal(error: unknown): void {
  console.error(`[malo-browser] 致命错误：${(error as Error)?.stack ?? String(error)}`);
  const code = exitCodeFor(error);
  try {
    app.exit(code);
  } finally {
    process.exit(code);
  }
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

let opts: Options;
let currentMode: string | null = null;
let maloDaemon: MaloDaemon | null = null;
if (isHelpRequested(process.argv.slice(1))) {
  console.log(USAGE);
  app.exit(0);
  process.exit(0);
}
if (isVersionRequested(process.argv.slice(1))) {
  console.log(app.getVersion());
  app.exit(0);
  process.exit(0);
}
try {
  opts = parseOptions(process.argv.slice(1));
  currentMode = opts.mode;
  debug(`parsed mode=${opts.mode} window=${opts.windowMode} url=${opts.url}`);
} catch (error) {
  console.error(`[malo-browser] 参数错误：${(error as Error).message}`);
  app.exit(2);
  throw error;
}

if (opts.mode === "daemon") {
  // Keep Chromium profile storage inside the malo data dir so one directory owns all state.
  app.setPath("userData", path.join(opts.dataDir, "chromium"));
}

protocol.registerSchemesAsPrivileged([
  { scheme: "demo", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (process.platform === "darwin") {
  try {
    const interactive =
      opts.mode === "stage" ||
      (opts.mode === "app" && !opts.autorun && !opts.headless && !opts.directorCheck);
    app.setActivationPolicy(interactive ? "regular" : "accessory");
    debug("activation policy set");
  } catch (error) {
    console.error(`[malo-browser] 设置激活策略失败：${(error as Error).message}`);
  }
}

app.whenReady().then(async () => {
  debug("app ready");
  const interactive =
    opts.mode === "stage" ||
    (opts.mode === "app" && !opts.autorun && !opts.headless && !opts.directorCheck);
  if (process.platform === "darwin" && !interactive) {
    app.dock?.hide();
  }
  try {
    if (opts.mode === "daemon") {
      Menu.setApplicationMenu(null);
      maloDaemon = await launchMaloDaemon({
        brokerPort: opts.daemonPort,
        portMin: opts.portMin,
        portMax: opts.portMax,
        leaseTtlMs: opts.leaseTtlSeconds * 1000,
        sessionIdleMs: opts.sessionIdleSeconds * 1000,
        maxSessionsPerLease: opts.maxSessionsPerLease,
        dataDir: opts.dataDir,
      });
      console.log(
        JSON.stringify({
          status: "ready",
          endpoint: maloDaemon.endpoint,
          broker_file: maloDaemon.brokerFile,
        }),
      );
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          const daemon = maloDaemon;
          maloDaemon = null;
          void (daemon?.close() ?? Promise.resolve()).finally(() => app.exit(0));
        });
      }
      return;
    }
    if (opts.mode === "app") {
      const controller = await launchApp({
        scenesRoot: opts.scenesRoot,
        outputRoot: opts.outDir,
        windowMode: opts.windowMode,
        showStage: opts.showStage,
        autorun: opts.autorun,
        directorCheck: opts.directorCheck,
        controlApi: opts.controlApi,
        controlPort: opts.controlPort,
        headless: opts.headless,
      });
      if (opts.autorun) {
        console.log(JSON.stringify({ status: "passed", recorder: controller.snapshot().recorder }));
        app.exit(0);
      } else if (opts.directorCheck) {
        app.exit(0);
      }
      return;
    }
    const code = await runPhase0(opts);
    debug(`run finished code=${code}`);
    app.exit(code);
  } catch (error) {
    console.error(`[malo-browser] 失败：${(error as Error).message}`);
    app.exit(exitCodeFor(error));
  }
});

app.on("window-all-closed", () => {
  if (currentMode === "app") app.quit();
});

app.on("before-quit", (event) => {
  const daemon = maloDaemon;
  if (!daemon) return;
  event.preventDefault();
  maloDaemon = null;
  void daemon.close().finally(() => app.quit());
});
