import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, copyFile, link, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DemoError } from "../../shared/errors";
import { createEncodeProgressLine, runToolWithProgress } from "../tools";
import { buildTimeline } from "./timeline";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 120_000;

const DEFAULT_FPS = 30;
const VIDEO_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease," +
  "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p";

export type RawFrame = { tMs: number; data: Buffer };
export type ToolPaths = { ffmpeg: string; ffprobe: string };

export type VideoProbe = {
  width: number;
  height: number;
  fps: number;
  durationS: number;
  frames: number;
};

export type BlackReport = {
  blackSeconds: number;
  ratio: number;
  durationS: number;
};

export type EncodeFramesOptions = {
  frames: RawFrame[];
  startMs: number;
  endMs: number;
  workDir: string;
  outPath: string;
  fps?: number;
  ffmpeg?: Partial<ToolPaths>;
};

export type EncodeFramesResult = {
  file: string;
  slots: number;
  expectedDurationS: number;
  rawFrames: number;
  rawDir: string;
  sequenceDir: string;
};

export type VerifyVideoOptions = {
  file: string;
  expectedDurationS: number;
  tools?: Partial<ToolPaths>;
  details?: Record<string, unknown>;
};

export type VerifiedVideo = {
  probe: VideoProbe;
  black: BlackReport;
  toleranceS: number;
};

export type EncodeCaptureOptions = EncodeFramesOptions & { keepFrames?: boolean };
export type EncodeCaptureResult = EncodeFramesResult & VerifiedVideo;

function findTool(name: "ffmpeg" | "ffprobe"): string {
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean);
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
    details: { tool: name },
  });
}

function resolveTool(name: "ffmpeg" | "ffprobe", tools?: Partial<ToolPaths>): string {
  const configured = tools?.[name];
  if (!configured) return findTool(name);
  try {
    accessSync(configured, constants.X_OK);
    return configured;
  } catch {
    throw new DemoError("E_FFMPEG_MISSING", `${name} 路径不可执行：${configured}`, {
      details: { tool: name, path: configured },
    });
  }
}

export function resolveToolPaths(tools?: Partial<ToolPaths>): ToolPaths {
  return {
    ffmpeg: resolveTool("ffmpeg", tools),
    ffprobe: resolveTool("ffprobe", tools),
  };
}

async function runProcess(
  bin: string,
  args: string[],
  details: Record<string, unknown> = {},
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(bin, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean; signal?: string };
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new DemoError("E_FFMPEG_FAILED", `${path.basename(bin)} 输出超过缓冲区上限`, {
        details: { ...details, tool: bin },
      });
    }
    if (err.killed || err.signal) {
      throw new DemoError("E_FFMPEG_FAILED", `${path.basename(bin)} 执行超时或被终止（上限 ${timeoutMs}ms）`, {
        details: { ...details, tool: bin },
      });
    }
    if (err.code === "ENOENT") {
      throw new DemoError("E_FFMPEG_MISSING", `找不到可执行文件：${bin}`, {
        details: { ...details, tool: bin },
      });
    }
    const stderr = (err.stderr ?? err.message).trim().split("\n").slice(-4).join(" | ");
    throw new DemoError("E_FFMPEG_FAILED", `${path.basename(bin)} 执行失败：${stderr}`, {
      details: { ...details, tool: bin, args },
    });
  }
}

function framePath(dir: string, index: number): string {
  return path.join(dir, `frame-${String(index).padStart(5, "0")}.jpg`);
}

async function materializeFrame(source: string, target: string): Promise<void> {
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

export async function encodeFrames(options: EncodeFramesOptions): Promise<EncodeFramesResult> {
  const fps = options.fps ?? DEFAULT_FPS;
  const file = path.resolve(options.outPath);
  if (path.extname(file).toLowerCase() !== ".mp4") {
    throw new DemoError("E_UNSUPPORTED", `录制输出必须是 .mp4：${file}`);
  }

  const slots = buildTimeline(options.frames, options.startMs, options.endMs, fps);
  const workDir = path.resolve(options.workDir);
  const stem = path.basename(file, path.extname(file));
  const rawDir = path.join(workDir, `${stem}-frames`);
  const sequenceDir = path.join(workDir, `${stem}-seq`);

  await rm(rawDir, { recursive: true, force: true });
  await rm(sequenceDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  await mkdir(sequenceDir, { recursive: true, mode: 0o700 });

  try {
    for (const [index, frame] of options.frames.entries()) {
      await writeFile(framePath(rawDir, index), frame.data);
    }
    for (const [index, frameIndex] of slots.entries()) {
      const source = framePath(rawDir, frameIndex);
      const target = path.join(sequenceDir, `${String(index).padStart(6, "0")}.jpg`);
      await materializeFrame(source, target);
    }

    await mkdir(path.dirname(file), { recursive: true });
    const tools = resolveToolPaths(options.ffmpeg);
    try {
      await runToolWithProgress(
        tools.ffmpeg,
        [
          "-y",
          "-v",
          "error",
          "-progress",
          "pipe:1",
          "-framerate",
          String(fps),
          "-i",
          path.join(sequenceDir, "%06d.jpg"),
          "-vf",
          VIDEO_FILTER,
          "-c:v",
          "libx264",
          "-crf",
          "18",
          "-preset",
          "slow",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          file,
        ],
        createEncodeProgressLine(slots.length),
        // 250ms per frame is a generous ceiling for 1080p "slow"; a hung encoder
        // must fail instead of blocking the take forever.
        Math.max(120_000, slots.length * 250),
      );
      await chmod(file, 0o600);
    } catch (error) {
      if (error instanceof DemoError) throw error;
      const message = (error as Error).message;
      const details = { tool: tools.ffmpeg, rawDir, sequenceDir, output: file };
      if (message.includes("ENOENT")) {
        throw new DemoError("E_FFMPEG_MISSING", `ffmpeg 无法执行：${message}`, { details });
      }
      throw new DemoError("E_FFMPEG_FAILED", `编码帧序列失败：${message}`, { details });
    }
  } catch (error) {
    if (error instanceof DemoError) throw error;
    throw new DemoError("E_FFMPEG_FAILED", `编码帧序列失败：${(error as Error).message}`, {
      details: { rawDir, sequenceDir, output: file },
    });
  }

  return {
    file,
    slots: slots.length,
    expectedDurationS: slots.length / fps,
    rawFrames: options.frames.length,
    rawDir,
    sequenceDir,
  };
}

export async function probeVideo(file: string, tools?: Partial<ToolPaths>): Promise<VideoProbe> {
  const { stdout } = await runProcess(resolveTool("ffprobe", tools), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,avg_frame_rate,nb_frames",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);

  let parsed: {
    streams?: { width?: number; height?: number; avg_frame_rate?: string; nb_frames?: string }[];
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new DemoError("E_EVIDENCE_MISMATCH", `ffprobe 输出不是合法 JSON：${file}`);
  }

  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `ffprobe 没有找到视频流：${file}`, {
      details: { parsed },
    });
  }

  const [num, den] = String(stream.avg_frame_rate ?? "").split("/").map(Number);
  const fps = den ? num / den : num;
  const width = Number(stream.width);
  const height = Number(stream.height);
  const durationS = Number(parsed.format?.duration);
  const frames = Number(stream.nb_frames);
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    !Number.isFinite(durationS) ||
    durationS <= 0 ||
    !Number.isFinite(frames) ||
    frames <= 0
  ) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `ffprobe 视频信息不完整：${file}`, {
      details: { width, height, fps, durationS, frames },
    });
  }
  return { width, height, fps, durationS, frames };
}

/** blackdetect decodes the whole file; 5s of wall clock per video second is ample. */
function decodeTimeoutMs(durationS: number): number {
  return Math.max(PROBE_TIMEOUT_MS, Math.ceil(durationS * 5_000));
}

async function blackSecondsOf(
  file: string,
  tools?: Partial<ToolPaths>,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<number> {
  const { stderr } = await runProcess(
    resolveTool("ffmpeg", tools),
    [
      "-v",
      "info",
      "-hide_banner",
      "-i",
      file,
      "-vf",
      "blackdetect=d=0.1:pix_th=0.10",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { file },
    timeoutMs,
  );
  let blackSeconds = 0;
  const pattern = /black_start:[\d.]+ black_end:[\d.]+ black_duration:([\d.]+)/g;
  for (const match of stderr.matchAll(pattern)) {
    blackSeconds += Number(match[1]);
  }
  return blackSeconds;
}

export async function blackReport(file: string, tools?: Partial<ToolPaths>): Promise<BlackReport> {
  const probe = await probeVideo(file, tools);
  const blackSeconds = await blackSecondsOf(file, tools, decodeTimeoutMs(probe.durationS));
  return {
    blackSeconds,
    ratio: probe.durationS > 0 ? blackSeconds / probe.durationS : 1,
    durationS: probe.durationS,
  };
}

export async function verifyVideo(options: VerifyVideoOptions): Promise<VerifiedVideo> {
  if (!Number.isFinite(options.expectedDurationS) || options.expectedDurationS <= 0) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `期望时长无效：${options.expectedDurationS}`);
  }

  const decodeTimeout = decodeTimeoutMs(options.expectedDurationS);
  const [probe, blackSeconds] = await Promise.all([
    probeVideo(options.file, options.tools),
    blackSecondsOf(options.file, options.tools, decodeTimeout),
  ]);
  const black: BlackReport = {
    blackSeconds,
    ratio: probe.durationS > 0 ? blackSeconds / probe.durationS : 1,
    durationS: probe.durationS,
  };
  const toleranceS = Math.max(0.5, options.expectedDurationS * 0.05);
  const deltaS = Math.abs(probe.durationS - options.expectedDurationS);
  const details = options.details ?? {};
  if (deltaS > toleranceS) {
    throw new DemoError(
      "E_EVIDENCE_MISMATCH",
      `视频时长 ${probe.durationS}s 与录制区间 ${options.expectedDurationS}s 相差 ${deltaS.toFixed(3)}s，超过容差 ${toleranceS.toFixed(3)}s`,
      {
        details: {
          ...details,
          file: options.file,
          durationS: probe.durationS,
          expectedDurationS: options.expectedDurationS,
          toleranceS,
        },
      },
    );
  }
  if (black.ratio > 0.5) {
    throw new DemoError(
      "E_EVIDENCE_MISMATCH",
      `黑帧占比 ${(black.ratio * 100).toFixed(1)}% 超过 50%`,
      {
        details: {
          ...details,
          file: options.file,
          blackSeconds: black.blackSeconds,
          durationS: black.durationS,
          ratio: black.ratio,
        },
      },
    );
  }
  return { probe, black, toleranceS };
}

export async function encodeCapture(options: EncodeCaptureOptions): Promise<EncodeCaptureResult> {
  const encoded = await encodeFrames(options);
  try {
    const verified = await verifyVideo({
      file: encoded.file,
      expectedDurationS: encoded.expectedDurationS,
      tools: options.ffmpeg,
      details: { rawDir: encoded.rawDir, sequenceDir: encoded.sequenceDir },
    });
    return { ...encoded, ...verified };
  } finally {
    // Verified or not, the intermediate frames are not a deliverable: a rejected
    // take would otherwise leave ~240 JPEGs per second of footage behind.
    if (!options.keepFrames) {
      await rm(encoded.sequenceDir, { recursive: true, force: true });
      await rm(encoded.rawDir, { recursive: true, force: true });
    }
  }
}
