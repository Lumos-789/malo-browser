import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent } from "../shared/types";
import type { DemoStagePreloadApi, DirectorSnapshot } from "./director-api";

// Sandboxed preloads cannot require local modules; keep the channel names inline.
const CHANNELS = {
  getSnapshot: "director:get-snapshot",
  send: "director:send",
  event: "director:event",
  openPath: "director:open-path",
} as const;

const api: DemoStagePreloadApi = {
  getSnapshot: (): Promise<DirectorSnapshot> => ipcRenderer.invoke(CHANNELS.getSnapshot),
  send: (command): Promise<void> => ipcRenderer.invoke(CHANNELS.send, command),
  onEvent: (listener: (event: AppEvent) => void): (() => void) => {
    const handler = (_event: unknown, payload: AppEvent) => listener(payload);
    ipcRenderer.on(CHANNELS.event, handler);
    return () => {
      ipcRenderer.off(CHANNELS.event, handler);
    };
  },
  openPath: (target: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openPath, target),
};

contextBridge.exposeInMainWorld("demoStage", api);
