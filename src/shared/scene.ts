export type SceneViewport = {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
};

export type StepAdvance = "auto" | "manual";

export type SceneStep = {
  id: string;
  action: string;
  note?: string;
  advance?: StepAdvance;
  holdMs?: number;
  waitAfterMs?: number;
  timeoutMs?: number;
  optional?: boolean;
  onError?: "stop" | "warn";
  [key: string]: unknown;
};

export type Scene = {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  url?: string;
  file?: string;
  viewport: SceneViewport;
  profile: string;
  allow: string[];
  permissions: string[];
  resetPolicy: "reload" | "clear-storage" | "new-session";
  vars: Record<string, string>;
  steps: SceneStep[];
  record?: Record<string, unknown>;
  /** Absolute scene directory; never part of the script hash. */
  rootDir: string;
};

export const SCENE_ACTIONS = [
  "goto",
  "login",
  "wait",
  "wait_for",
  "wait_for_presenter",
  "click",
  "fill",
  "press",
  "scroll",
  "highlight",
  "spotlight",
  "annotate",
  "mask",
  "blackout",
  "assert",
  "scene",
  "set",
  "note",
  "screenshot",
] as const;

export type SceneAction = (typeof SCENE_ACTIONS)[number];
