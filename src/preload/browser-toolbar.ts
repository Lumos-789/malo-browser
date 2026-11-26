import { contextBridge, ipcRenderer } from "electron";
import type {
  BrowserToolbarApi,
  BrowserToolbarNavigateResult,
  BrowserToolbarState,
  HumanPanelState,
} from "../shared/toolbar";

// Sandboxed preloads cannot require local modules; keep the channel names inline.
const CHANNELS = {
  navigate: "toolbar:navigate",
  back: "toolbar:back",
  forward: "toolbar:forward",
  reload: "toolbar:reload",
  state: "toolbar:state",
  done: "human:done",
  pause: "human:pause",
  resume: "human:resume",
  stop: "human:stop",
  human: "human:state",
} as const;

const api: BrowserToolbarApi = {
  navigate: (input: string): Promise<BrowserToolbarNavigateResult> =>
    ipcRenderer.invoke(CHANNELS.navigate, input),
  back: (): Promise<void> => ipcRenderer.invoke(CHANNELS.back),
  forward: (): Promise<void> => ipcRenderer.invoke(CHANNELS.forward),
  reload: (): Promise<void> => ipcRenderer.invoke(CHANNELS.reload),
  onState: (listener: (state: BrowserToolbarState) => void): (() => void) => {
    const handler = (_event: unknown, payload: BrowserToolbarState) => listener(payload);
    ipcRenderer.on(CHANNELS.state, handler);
    return () => {
      ipcRenderer.off(CHANNELS.state, handler);
    };
  },
  done: (): Promise<void> => ipcRenderer.invoke(CHANNELS.done),
  pause: (): Promise<void> => ipcRenderer.invoke(CHANNELS.pause),
  resume: (): Promise<void> => ipcRenderer.invoke(CHANNELS.resume),
  stop: (): Promise<void> => ipcRenderer.invoke(CHANNELS.stop),
  onHuman: (listener: (state: HumanPanelState) => void): (() => void) => {
    const handler = (_event: unknown, payload: HumanPanelState) => listener(payload);
    ipcRenderer.on(CHANNELS.human, handler);
    return () => {
      ipcRenderer.off(CHANNELS.human, handler);
    };
  },
};

contextBridge.exposeInMainWorld("maloToolbar", api);
