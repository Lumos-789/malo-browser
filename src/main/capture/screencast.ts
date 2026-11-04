import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DemoError } from "../../shared/errors";
import type { CaptureSummary, RecorderPort } from "../core/ports";
import {
  encodeCapture,
  type RawFrame,
  type ToolPaths,
  type VideoProbe,
} from "./encode";
import { sha256File } from "./evidence";

export type DebuggerMessageListener = (
  event: unknown,
  method: string,
  params: any,
  sessionId?: string,
) => void;

export interface DebuggerHost {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "message", listener: DebuggerMessageListener): unknown;
  off(event: "message", listener: DebuggerMessageListener): unknown;
}

export type ScreencastRecorderOptions = {
  webContents: DebuggerHost;
  outDir: string;
  /** 默认输出路径；start({ output }) 优先。相对路径按 outDir 解析。 */
  output?: string;
  fps?: number;
  quality?: number;
  ffmpeg?: ToolPaths;
};

export type ScreencastCaptureSummary = CaptureSummary & {
  rawFrames: number;
  ackErrors: number;
  expectedDurationS: number;
  timelineFrames: number;
  blackRatio: number;
  probe: VideoProbe;
};

const DEFAULT_FPS = 30;
const DEFAULT_QUALITY = 90;
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const DRAIN_MS = 250;

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultTakeName(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "");
  return `take-${stamp}.mp4`;
}

type RecorderState = "idle" | "recording" | "stopping" | "failed";

export class ScreencastRecorder implements RecorderPort {
  private readonly host: DebuggerHost;
  private readonly outDir: string;
  private readonly defaultOutput?: string;
  private readonly fps: number;
  private readonly quality: number;
  private readonly ffmpeg?: ToolPaths;

  private frames: RawFrame[] = [];
  private startedAtMs = 0;
  private stoppedAtMs = 0;
  private ackErrors = 0;
  private ackErrorMessages: string[] = [];
  private protocolErrors: string[] = [];
  private pendingAcks = new Set<Promise<void>>();
  private listener: DebuggerMessageListener | null = null;
  private output: string | null = null;
  private state: RecorderState = "idle";

  constructor(options: ScreencastRecorderOptions) {
    this.host = options.webContents;
    this.outDir = path.resolve(options.outDir);
    this.defaultOutput = options.output
      ? path.resolve(this.outDir, options.output)
      : undefined;
    this.fps = options.fps ?? DEFAULT_FPS;
    this.quality = options.quality ?? DEFAULT_QUALITY;
    this.ffmpeg = options.ffmpeg;

    if (!Number.isFinite(this.fps) || this.fps <= 0) {
      throw new DemoError("E_UNSUPPORTED", `录制帧率无效：${this.fps}`);
    }
    if (!Number.isInteger(this.quality) || this.quality < 1 || this.quality > 100) {
      throw new DemoError("E_UNSUPPORTED", `录制质量必须在 1-100：${this.quality}`);
    }
  }

  async start(options: { output?: string } = {}): Promise<void> {
    if (this.state !== "idle") {
      throw new DemoError("E_UNSUPPORTED", `录制器状态为 ${this.state}，不能开始新录制`);
    }
    const output = options.output
      ? path.resolve(this.outDir, options.output)
      : this.defaultOutput ?? path.join(this.outDir, defaultTakeName());
    if (path.extname(output).toLowerCase() !== ".mp4") {
      throw new DemoError("E_UNSUPPORTED", `录制输出必须是 .mp4：${output}`);
    }

    await mkdir(path.dirname(output), { recursive: true });
    this.output = output;
    this.frames = [];
    this.ackErrors = 0;
    this.ackErrorMessages = [];
    this.protocolErrors = [];
    this.pendingAcks.clear();

    this.state = "recording";
    this.listener = (_event, method, params) => this.handleMessage(method, params);
    try {
      this.host.on("message", this.listener);
    } catch (error) {
      this.listener = null;
      this.state = "failed";
      throw new DemoError(
        "E_CDP_ATTACH_FAILED",
        `注册 CDP 事件监听失败：${(error as Error).message}`,
      );
    }

    try {
      if (!this.host.isAttached()) this.host.attach("1.3");
    } catch (error) {
      if (!this.host.isAttached()) {
        this.removeListener();
        this.state = "failed";
        throw new DemoError("E_CDP_ATTACH_FAILED", `CDP 附加失败：${(error as Error).message}`);
      }
    }

    this.startedAtMs = nowMs();
    try {
      await this.host.sendCommand("Page.startScreencast", {
        format: "jpeg",
        quality: this.quality,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        everyNthFrame: 1,
      });
    } catch (error) {
      this.removeListener();
      this.state = "failed";
      throw new DemoError("E_CDP_ATTACH_FAILED", `启动 screencast 失败：${(error as Error).message}`);
    }
  }

  async stop(): Promise<ScreencastCaptureSummary> {
    if (this.state !== "recording") {
      throw new DemoError("E_UNSUPPORTED", `录制器状态为 ${this.state}，没有可停止的录制`);
    }
    this.state = "stopping";

    let stopError: DemoError | null = null;
    try {
      await this.host.sendCommand("Page.stopScreencast");
    } catch (error) {
      stopError = new DemoError(
        "E_CDP_ATTACH_FAILED",
        `停止 screencast 失败：${(error as Error).message}`,
      );
    }
    this.stoppedAtMs = nowMs();

    await delay(DRAIN_MS);
    this.removeListener();
    await Promise.allSettled([...this.pendingAcks]);

    try {
      if (stopError) throw stopError;
      if (this.protocolErrors.length > 0) {
        throw new DemoError(
          "E_EVIDENCE_MISMATCH",
          `screencast 收到 ${this.protocolErrors.length} 个非法帧事件`,
          { details: { errors: this.protocolErrors } },
        );
      }
      if (this.ackErrors > 0) {
        throw new DemoError(
          "E_EVIDENCE_MISMATCH",
          `screencastFrameAck 失败 ${this.ackErrors} 次`,
          { details: { ack_errors: this.ackErrors, messages: this.ackErrorMessages } },
        );
      }
      if (this.frames.length === 0) {
        throw new DemoError(
          "E_RECORDER_NO_FRAMES",
          `录制 ${((this.stoppedAtMs - this.startedAtMs) / 1000).toFixed(3)}s 没有收到任何画面帧`,
          {
            details: {
              started_at_ms: this.startedAtMs,
              stopped_at_ms: this.stoppedAtMs,
            },
          },
        );
      }
      if (!this.output) {
        throw new DemoError("E_UNSUPPORTED", "录制输出路径未初始化");
      }

      const frames = [...this.frames];
      const startedAtMs = this.startedAtMs;
      const stoppedAtMs = this.stoppedAtMs;
      this.frames = [];

      const encoded = await encodeCapture({
        frames,
        startMs: startedAtMs,
        endMs: stoppedAtMs,
        workDir: this.outDir,
        outPath: this.output,
        fps: this.fps,
        ffmpeg: this.ffmpeg,
      });
      const sha256 = await sha256File(encoded.file);
      this.state = "idle";

      return {
        file: encoded.file,
        frames: encoded.probe.frames,
        durationS: encoded.probe.durationS,
        width: encoded.probe.width,
        height: encoded.probe.height,
        fps: encoded.probe.fps,
        sha256,
        rawFrames: encoded.rawFrames,
        ackErrors: 0,
        expectedDurationS: encoded.expectedDurationS,
        timelineFrames: encoded.slots,
        blackRatio: encoded.black.ratio,
        probe: encoded.probe,
      };
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  private handleMessage(method: string, params: unknown): void {
    if (method !== "Page.screencastFrame") return;
    if (this.state !== "recording" && this.state !== "stopping") return;

    const frame = params as { data?: unknown; sessionId?: unknown } | null;
    if (
      typeof frame?.data !== "string" ||
      frame.data.length === 0 ||
      typeof frame.sessionId !== "number"
    ) {
      this.protocolErrors.push(
        JSON.stringify({
          sessionId: frame?.sessionId ?? null,
          data_bytes: typeof frame?.data === "string" ? frame.data.length : null,
        }),
      );
      return;
    }

    this.frames.push({ tMs: nowMs(), data: Buffer.from(frame.data, "base64") });
    let ack: Promise<void>;
    try {
      ack = this.host
        .sendCommand("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .then(() => undefined)
        .catch((error: unknown) => {
          this.ackErrors += 1;
          if (this.ackErrorMessages.length < 3) {
            this.ackErrorMessages.push((error as Error).message);
          }
        });
    } catch (error) {
      this.ackErrors += 1;
      if (this.ackErrorMessages.length < 3) {
        this.ackErrorMessages.push((error as Error).message);
      }
      return;
    }
    this.pendingAcks.add(ack);
    void ack.finally(() => this.pendingAcks.delete(ack));
  }

  private removeListener(): void {
    if (!this.listener) return;
    this.host.off("message", this.listener);
    this.listener = null;
  }
}
