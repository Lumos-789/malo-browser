import type { WebContents } from "electron";
import { sleep } from "./tools";

export type RawFrame = { tMs: number; data: Buffer };

export type CaptureResult = {
  frames: RawFrame[];
  startedAtMs: number;
  stoppedAtMs: number;
  durationMs: number;
  ackErrors: number;
};

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

export class ScreencastRecorder {
  private frames: RawFrame[] = [];
  private startedAtMs = 0;
  private ackErrors = 0;
  private listener: ((...args: any[]) => void) | null = null;

  constructor(private readonly wc: WebContents) {}

  async start(options: { quality: number; maxWidth: number; maxHeight: number }): Promise<void> {
    this.listener = (_event: unknown, method: string, params: any) => {
      if (method !== "Page.screencastFrame") return;
      this.frames.push({ tMs: nowMs(), data: Buffer.from(params.data, "base64") });
      this.wc.debugger
        .sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId })
        .catch(() => {
          this.ackErrors += 1;
        });
    };
    this.wc.debugger.on("message", this.listener);
    this.startedAtMs = nowMs();
    await this.wc.debugger.sendCommand("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality,
      maxWidth: options.maxWidth,
      maxHeight: options.maxHeight,
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<CaptureResult> {
    await this.wc.debugger.sendCommand("Page.stopScreencast");
    const stoppedAtMs = nowMs();
    await sleep(250);
    if (this.listener) {
      this.wc.debugger.removeListener("message", this.listener);
      this.listener = null;
    }
    const frames = this.frames.filter((frame) => frame.tMs <= stoppedAtMs + 250);
    return {
      frames,
      startedAtMs: this.startedAtMs,
      stoppedAtMs,
      durationMs: stoppedAtMs - this.startedAtMs,
      ackErrors: this.ackErrors,
    };
  }
}
