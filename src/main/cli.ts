import os from "node:os";
import path from "node:path";

export type Mode = "stage" | "record" | "smoke" | "app" | "daemon";
export type WindowMode = "hidden" | "inactive" | "offscreen" | "ghost" | "focused";

export type Options = {
  mode: Mode;
  windowMode: WindowMode;
  focusEmulation: boolean;
  plain: boolean;
  url: string;
  outDir: string;
  seconds: number;
  width: number;
  height: number;
  label: string;
  keepFrames: boolean;
  scenesRoot: string;
  showStage: boolean;
  autorun: string | null;
  directorCheck: boolean;
  controlApi: boolean;
  controlPort: number;
  headless: boolean;
  daemonPort: number;
  portMin: number;
  portMax: number;
  leaseTtlSeconds: number;
  sessionIdleSeconds: number;
  maxSessionsPerLease: number;
  dataDir: string;
};

const MODES: Mode[] = ["stage", "record", "smoke", "app", "daemon"];
const WINDOW_MODES: WindowMode[] = ["hidden", "inactive", "offscreen", "ghost", "focused"];

export const KNOWN_FLAGS: readonly string[] = [
  "mode",
  "window-mode",
  "focus-emulation",
  "plain",
  "url",
  "out",
  "seconds",
  "width",
  "height",
  "label",
  "keep-frames",
  "scenes",
  "show-stage",
  "show",
  "autorun",
  "director-check",
  "control-api",
  "control-port",
  "headless",
  "daemon-port",
  "port-min",
  "port-max",
  "lease-ttl-seconds",
  "session-idle-seconds",
  "max-sessions",
  "data-dir",
  "help",
  "version",
];

// Electron 转发自身的调试开关到 process.argv，不能当成用户拼错。
const PASSTHROUGH_FLAGS = new Set(["inspect", "inspect-brk", "remote-debugging-port", "enable-logging"]);

export const USAGE = `Malo Browser — 演示用浏览器

用法：electron . --mode=<stage|record|smoke|app|daemon> [参数]

模式：
  stage    可见 Stage，手动体验页面（默认）
  record   无头录制（默认 10 秒）
  smoke    冒烟录制（默认 3 秒）
  app      Director 控制台 + Stage（场景、控制 API）
  daemon   malo-browser 后台 broker：向多个 agent 分发端口和隔离 session

参数（默认值）：
  --url=<url>                http://127.0.0.1:4788/index.html
  --width=<n> --height=<n>   视口，1440x900
  --seconds=<n>              record 默认 10，smoke 默认 3
  --out=<dir>                输出目录，./evidence
  --label=<name>             产物文件名（一段路径，不含 / ），默认同窗口模式
  --window-mode=<mode>       hidden | inactive | offscreen | ghost | focused
  --focus-emulation=false    关闭焦点仿真（隐藏窗口点击会被丢弃）
  --plain=true               不做交互，只录静态页
  --keep-frames=true         保留原始帧
  --scenes=<dir>             场景根目录，./fixtures/scenes
  --show-stage=true          app 模式显示 Stage（不抢焦点）
  --autorun=<scene>          无头跑完整场景并出片
  --director-check=true      隐形校验 Director 与 preload 桥接
  --control-api=true         启动本地控制 API（配合 --control-port）
  --control-port=<n>         默认 7317
  --headless=true            全无窗口后台实例
  --daemon-port=<n>          malo-browser broker 端口，默认 7410
  --port-min=<n>             lease 端口池起点，默认 7411
  --port-max=<n>             lease 端口池终点，默认 7499
  --lease-ttl-seconds=<n>    lease 过期秒数，默认 300
  --session-idle-seconds=<n> 空闲 session 回收秒数，默认 300
  --max-sessions=<n>         每个 lease 最大 session 数，默认 4
  --data-dir=<dir>           malo-browser 数据目录，默认 ~/.malo-browser

示例：
  electron . --mode=record --seconds=10 --out=evidence --label=hidden
  electron . --mode=app --autorun=report-review --scenes=fixtures/scenes
  electron . --mode=daemon --daemon-port=7410 --port-min=7411 --port-max=7499

参数拼错会直接报错退出；--help 可随时打印本说明，--version 打印版本号。
更多说明见 README.md 与 docs/malo-browser.md。`;

export function isHelpRequested(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function isVersionRequested(argv: string[]): boolean {
  return argv.includes("--version") || argv.includes("-v");
}

function validateFlags(argv: string[]): void {
  for (const arg of argv) {
    if (!arg.startsWith("--") || arg === "--") continue;
    const name = arg.slice(2).split("=", 1)[0];
    if (name === "" || PASSTHROUGH_FLAGS.has(name)) continue;
    if (!KNOWN_FLAGS.includes(name)) {
      throw new Error(`未知参数 --${name}；运行 --help 查看可用参数`);
    }
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const withValue = argv.find((arg) => arg.startsWith(prefix));
  if (withValue) return withValue.slice(prefix.length);
  return argv.includes(`--${name}`) ? "true" : undefined;
}

function readNumber(argv: string[], name: string, fallback: number): number {
  const raw = readFlag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`参数 --${name} 必须为正数，收到 ${raw}`);
  }
  return value;
}

function readPort(argv: string[], name: string, fallback: number): number {
  const value = readNumber(argv, name, fallback);
  if (!Number.isInteger(value) || value > 65535) {
    throw new Error(`参数 --${name} 必须是 1-65535 的整数端口，收到 ${value}`);
  }
  return value;
}

function readPositiveInteger(argv: string[], name: string, fallback: number, max: number): number {
  const value = readNumber(argv, name, fallback);
  if (!Number.isInteger(value) || value > max) {
    throw new Error(`参数 --${name} 必须是 1-${max} 的整数，收到 ${value}`);
  }
  return value;
}

// label 直接拼进 `<out>/<label>.mp4` 等产物路径：含路径分隔符会逃出输出目录或
// 落进不存在的子目录，空串则产物名变成 `.mp4`，都在参数阶段拦下。
function readLabel(argv: string[], fallback: string): string {
  const label = readFlag(argv, "label") ?? fallback;
  if (label.trim() === "" || label === "." || label === ".." || label.includes("/") || label.includes("\\")) {
    throw new Error(
      `参数 --label 是产物文件名的一段，不能为空、不能是 . 或 .. 、不能包含路径分隔符 / 或 \\，收到 "${label}"；换输出目录请用 --out`,
    );
  }
  return label;
}

// 命令行里的 ~ 不会被 shell 展开（`--data-dir=~/.malo-browser` 是一个整体参数），
// 直接在代码里展开，避免悄悄建出一个名为 "~" 的目录。
export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function parseOptions(argv: string[]): Options {
  validateFlags(argv);
  const mode = (readFlag(argv, "mode") ?? "stage") as Mode;
  if (!MODES.includes(mode)) {
    throw new Error(`未知模式 ${mode}，可选 ${MODES.join(" / ")}`);
  }
  const autorun = readFlag(argv, "autorun") ?? null;
  const directorCheck = readFlag(argv, "director-check") === "true";
  const headless = readFlag(argv, "headless") === "true";
  const showStage = readFlag(argv, "show-stage") === "true" || readFlag(argv, "show") === "true";
  // Recording stays headless; an interactive Director session opens the stage
  // without stealing focus so the presenter can actually see it.
  const interactive = mode === "app" && !autorun && !directorCheck;
  const defaultWindowMode: WindowMode =
    !headless && (interactive || showStage) ? "inactive" : "hidden";
  const requestedWindowMode = (readFlag(argv, "window-mode") ?? defaultWindowMode) as WindowMode;
  if (!WINDOW_MODES.includes(requestedWindowMode)) {
    throw new Error(`未知窗口模式 ${requestedWindowMode}，可选 ${WINDOW_MODES.join(" / ")}`);
  }
  const daemonPort = readPort(argv, "daemon-port", 7410);
  const portMin = readPort(argv, "port-min", 7411);
  const portMax = readPort(argv, "port-max", 7499);
  if (portMin > portMax) {
    throw new Error(`lease 端口池范围无效：${portMin}-${portMax}`);
  }
  if (daemonPort >= portMin && daemonPort <= portMax) {
    throw new Error(`--daemon-port=${daemonPort} 不能落在 lease 端口池 ${portMin}-${portMax} 内`);
  }
  const maxSessionsPerLease = readPositiveInteger(argv, "max-sessions", 4, 64);
  const focusFlag = readFlag(argv, "focus-emulation");
  return {
    mode,
    windowMode: requestedWindowMode,
    focusEmulation: focusFlag === undefined ? true : focusFlag !== "false",
    plain: readFlag(argv, "plain") === "true",
    url: readFlag(argv, "url") ?? "http://127.0.0.1:4788/index.html",
    outDir: expandHome(readFlag(argv, "out") ?? `${process.cwd()}/evidence`),
    seconds: readNumber(argv, "seconds", mode === "smoke" ? 3 : 10),
    width: readNumber(argv, "width", 1440),
    height: readNumber(argv, "height", 900),
    label: readLabel(argv, requestedWindowMode),
    keepFrames: readFlag(argv, "keep-frames") === "true",
    scenesRoot: expandHome(readFlag(argv, "scenes") ?? `${process.cwd()}/fixtures/scenes`),
    showStage,
    autorun,
    directorCheck,
    controlApi: readFlag(argv, "control-api") === "true",
    controlPort: readNumber(argv, "control-port", 7317),
    headless,
    daemonPort,
    portMin,
    portMax,
    leaseTtlSeconds: readPositiveInteger(argv, "lease-ttl-seconds", 300, 86_400),
    sessionIdleSeconds: readPositiveInteger(argv, "session-idle-seconds", 300, 86_400),
    maxSessionsPerLease,
    dataDir: path.resolve(expandHome(readFlag(argv, "data-dir") ?? path.join(os.homedir(), ".malo-browser"))),
  };
}
