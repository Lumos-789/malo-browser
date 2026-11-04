import type { Point, Rect } from "../../shared/types";

export type SpotlightOptions = { padding?: number; dim?: number; seconds?: number };
export type AnnotateOptions = { text: string; position?: "top" | "bottom" | "left" | "right"; seconds?: number };
export type MaskOptions = { mode?: "blur" | "solid"; color?: string };

export interface OverlayPort {
  move(point: Point): Promise<void>;
  click(point: Point): Promise<void>;
  highlight(rect: Rect, seconds: number, color?: string): Promise<void>;
  spotlight(rect: Rect, options?: SpotlightOptions): Promise<void>;
  annotate(rect: Rect, options: AnnotateOptions): Promise<void>;
  mask(rect: Rect, options?: MaskOptions): Promise<void>;
  blackout(on: boolean): Promise<void>;
  clear(): Promise<void>;
}

export type CaptureSummary = {
  file: string;
  frames: number;
  durationS: number;
  width: number;
  height: number;
  fps: number;
  sha256: string;
};

export interface RecorderPort {
  start(options?: { output?: string }): Promise<void>;
  stop(): Promise<CaptureSummary>;
}
