import type { AppEvent, AppSnapshot, ControlCommand, DisplaySummary } from "../shared/types";

export type DirectorSceneSummary = {
  id: string;
  title: string;
  description?: string;
  stepTotal: number;
  profile?: string;
};

/**
 * Runtime snapshot handed to the Director. `scenes` is the workspace scene
 * list; when the main process omits it the Director falls back to the loaded
 * scene from `stage`.
 */
export type DirectorSnapshot = AppSnapshot & {
  scenes?: DirectorSceneSummary[];
  displays?: DisplaySummary[];
};

export type DemoStagePreloadApi = {
  getSnapshot(): Promise<DirectorSnapshot>;
  onEvent(listener: (event: AppEvent) => void): () => void;
  send(command: ControlCommand): Promise<void>;
  openPath(path: string): Promise<void>;
};

export const DIRECTOR_CHANNELS = {
  getSnapshot: "director:get-snapshot",
  send: "director:send",
  event: "director:event",
  openPath: "director:open-path",
} as const;

declare global {
  interface Window {
    demoStage?: DemoStagePreloadApi;
  }
}
