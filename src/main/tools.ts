import { accessSync, constants, existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { DemoError } from "../shared/errors";

const execFileAsync = promisify(execFile);

const FALLBACK_TOOL_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] as const;

export function resolveToolOnPath(
  name: "ffmpeg" | "ffprobe",
  pathValue: string | undefined,
  fallbackDirs: readonly string[] = FALLBACK_TOOL_DIRS,
): string {
  const dirs = [...(pathValue ?? "").split(path.delimiter), ...fallbackDirs].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new DemoError("E_FFMPEG_MISSING", `找不到 ${name}，请先安装 ffmpeg`, {
    details: { tool: name, path: pathValue ?? "", fallback_dirs: [...fallbackDirs] },
  });
}

export function resolveTool(name: "ffmpeg" | "ffprobe"): string {
  return resolveToolOnPath(name, process.env.PATH);
}

export async function runTool(
  bin: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(bin, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    const err = error as { stderr?: string; message: string; killed?: boolean; signal?: string };
    if (err.killed || err.signal) {
      throw new Error(`${bin} 执行超时（${timeoutMs}ms）已被终止`);
    }
    throw new Error(`${bin} 执行失败：${(err.stderr ?? err.message).trim().split("\n").slice(-4).join(" | ")}`);
  }
}

export function runToolWithProgress(
  bin: string,
  args: string[],
  onFrame?: (frame: number) => void,
  timeoutMs = 20 * 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let pending = "";
    let lastFrame: number | null = null;
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    // A hung encoder must not hang stop(): kill it and fail with a real reason.
    timer = setTimeout(() => {
      fail(new Error(`${bin} 执行超时（${timeoutMs}ms）已被终止`));
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => fail(new Error(`${bin} 执行失败：${error.message}`)));
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const frame = /^frame=(\d+)/.exec(line);
        if (frame) {
          lastFrame = Number(frame[1]);
          continue;
        }
        if (/^progress=/.test(line) && lastFrame !== null && onFrame) onFrame(lastFrame);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        if (!settled) {
          settled = true;
          resolve();
        }
        return;
      }
      const tail = stderr.trim().split("\n").slice(-4).join(" | ") || `exit ${code}`;
      fail(new Error(`${bin} 执行失败：${tail}`));
    });
  });
}

export function createEncodeProgressLine(totalSlots: number): (frame: number) => void {
  let bucket = 0;
  return (frame) => {
    const percent = Math.min(100, Math.floor((frame / Math.max(1, totalSlots)) * 100));
    const step = Math.floor(percent / 10);
    if (percent === 0 || step <= bucket) return;
    bucket = step;
    console.error(`[malo-browser] 编码 ${percent}%（${frame}/${totalSlots} 帧）`);
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatOverwriteWarning(label: string, existingFiles: string[]): string | null {
  if (existingFiles.length === 0) return null;
  const listed = existingFiles.map((file) => `  - ${file}`).join("\n");
  return `label「${label}」已有上一轮产物，本次录制将直接覆盖：\n${listed}\n要保留旧产物，请换 --label 或先移走旧文件再跑`;
}

export function controlApiTokenHint(recordFile: string): string {
  return `鉴权 token 已写入 ${recordFile}（0600），请求头写法与 curl 示例见 README.md 的 App control API 节`;
}

export type ListenSurface = "control" | "broker" | "lease";

const LISTEN_HINTS: Record<ListenSurface, { label: string; reason: string; fix: string }> = {
  control: {
    label: "控制 API",
    reason: "很可能另一个 malo-browser 实例还在运行",
    fix: "关闭旧实例后重试，或用 --control-port=<n> 换一个端口",
  },
  broker: {
    label: "broker",
    reason: "另一个 malo-browser daemon 仍占着这个端口",
    fix: "先停止旧 daemon，或用 --daemon-port=<n> 换一个端口",
  },
  lease: {
    label: "lease",
    reason: "租约端口池和已有实例重叠",
    fix: "用 --port-min/--port-max 换一段端口",
  },
};

export function explainListenFailure(
  port: number,
  error: unknown,
  surface: ListenSurface = "control",
): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code !== "EADDRINUSE" && !message.includes("EADDRINUSE")) return error;
  const where = port > 0 ? `127.0.0.1:${port}` : "请求的回环地址";
  const hint = LISTEN_HINTS[surface];
  return new Error(
    `${hint.label} 端口被占用（${where}）——${hint.reason}。${hint.fix}。原始错误：${message}`,
    { cause: error },
  );
}

export function explainLoadFailure(url: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("ERR_CONNECTION_REFUSED")) return error;
  const hint = url.startsWith("http://127.0.0.1:4788")
    ? "若在跑 README 快速开始，请先另开终端启动 fixture 静态服务：python3 -m http.server 4788 --bind 127.0.0.1 --directory out/fixture"
    : "目标地址的服务没有启动或端口不对，请先确认服务已在监听再重试";
  return new Error(`页面无法连接：${url}（net::ERR_CONNECTION_REFUSED）。${hint}`, { cause: error });
}
