import { chmod, link, mkdir, open, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RawFrame } from "./recorder";
import { createEncodeProgressLine, resolveTool, runTool, runToolWithProgress } from "./tools";

export type VideoProbe = {
  width: number;
  height: number;
  fps: number;
  durationS: number;
  frames: number;
};

const VIDEO_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease," +
  "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p";

export async function encodeFrames(params: {
  frames: RawFrame[];
  captureStartMs: number;
  captureEndMs: number;
  workDir: string;
  outPath: string;
  fps: number;
  keepFrames: boolean;
}): Promise<{ slots: number; expectedDurationS: number; rawFrames: number }> {
  const { frames, captureStartMs, captureEndMs, workDir, outPath, fps } = params;
  if (frames.length === 0) {
    throw new Error("E_RECORDER_NO_FRAMES: 没有采到任何画面帧");
  }

  const rawDir = path.join(workDir, `${path.basename(outPath, ".mp4")}-frames`);
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });
  for (const [index, frame] of frames.entries()) {
    await writeFile(path.join(rawDir, `frame-${String(index).padStart(5, "0")}.jpg`), frame.data);
  }

  const durationS = (captureEndMs - captureStartMs) / 1000;
  const total = Math.max(1, Math.round(durationS * fps));
  const slots: number[] = new Array(total).fill(-1);
  for (const [index, frame] of frames.entries()) {
    const slot = Math.min(total - 1, Math.max(0, Math.round(((frame.tMs - captureStartMs) / 1000) * fps)));
    slots[slot] = index;
  }
  let current = slots.find((slot) => slot >= 0) ?? 0;
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i] < 0) slots[i] = current;
    else current = slots[i];
  }

  const seqDir = path.join(workDir, `${path.basename(outPath, ".mp4")}-seq`);
  await rm(seqDir, { recursive: true, force: true });
  await mkdir(seqDir, { recursive: true });
  for (const [i, frameIndex] of slots.entries()) {
    const source = path.join(rawDir, `frame-${String(frameIndex).padStart(5, "0")}.jpg`);
    const target = path.join(seqDir, `${String(i).padStart(6, "0")}.jpg`);
    try {
      await link(source, target);
    } catch {
      const handle = await open(source, "r");
      try {
        await writeFile(target, await handle.readFile());
      } finally {
        await handle.close();
      }
    }
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  const ffmpeg = resolveTool("ffmpeg");
  await runToolWithProgress(
    ffmpeg,
    [
      "-y",
      "-v",
      "error",
      "-progress",
      "pipe:1",
      "-framerate",
      String(fps),
      "-i",
      path.join(seqDir, "%06d.jpg"),
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
      outPath,
    ],
    createEncodeProgressLine(total),
  );
  await chmod(outPath, 0o600);

  if (!params.keepFrames) {
    await rm(seqDir, { recursive: true, force: true });
    await rm(rawDir, { recursive: true, force: true });
  }
  return { slots: total, expectedDurationS: total / fps, rawFrames: frames.length };
}

export async function probeVideo(file: string): Promise<VideoProbe> {
  const ffprobe = resolveTool("ffprobe");
  const { stdout } = await runTool(ffprobe, [
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
  const parsed = JSON.parse(stdout) as {
    streams: { width: number; height: number; avg_frame_rate: string; nb_frames?: string }[];
    format: { duration: string };
  };
  const stream = parsed.streams[0];
  const [num, den] = stream.avg_frame_rate.split("/").map(Number);
  return {
    width: stream.width,
    height: stream.height,
    fps: den ? num / den : num,
    durationS: Number(parsed.format.duration),
    frames: Number(stream.nb_frames ?? 0),
  };
}

export async function blackReport(file: string): Promise<{ blackSeconds: number; ratio: number; durationS: number }> {
  const ffmpeg = resolveTool("ffmpeg");
  const { stderr } = await runTool(ffmpeg, [
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
  ]);
  const probe = await probeVideo(file);
  let blackSeconds = 0;
  const pattern = /black_start:[\d.]+ black_end:[\d.]+ black_duration:([\d.]+)/g;
  for (const match of stderr.matchAll(pattern)) {
    blackSeconds += Number(match[1]);
  }
  return {
    blackSeconds,
    ratio: probe.durationS > 0 ? blackSeconds / probe.durationS : 1,
    durationS: probe.durationS,
  };
}

export async function extractFrame(file: string, atSeconds: number, outPath: string): Promise<void> {
  const ffmpeg = resolveTool("ffmpeg");
  await mkdir(path.dirname(outPath), { recursive: true });
  await runTool(ffmpeg, [
    "-y",
    "-v",
    "error",
    "-ss",
    atSeconds.toFixed(2),
    "-i",
    file,
    "-frames:v",
    "1",
    outPath,
  ]);
  await chmod(outPath, 0o600);
}

export async function ssim(a: string, b: string, seconds: number): Promise<number> {
  const ffmpeg = resolveTool("ffmpeg");
  const filter =
    `[0:v]trim=0:${seconds},setpts=PTS-STARTPTS[x];` +
    `[1:v]trim=0:${seconds},setpts=PTS-STARTPTS[y];[x][y]ssim`;
  const { stderr } = await runTool(ffmpeg, ["-v", "info", "-hide_banner", "-i", a, "-i", b, "-lavfi", filter, "-f", "null", "-"]);
  const hit = stderr.match(/All:([\d.]+)/);
  if (!hit) throw new Error(`SSIM 解析失败：${stderr.split("\n").slice(-3).join(" | ")}`);
  return Number(hit[1]);
}
