import { contextBridge, ipcRenderer } from "electron";
import type {
  BrowserToolbarApi,
  BrowserToolbarNavigateResult,
  BrowserToolbarState,
} from "../shared/toolbar";

// Sandboxed preloads cannot require local modules; keep the channel names inline.
const CHANNELS = {
  navigate: "toolbar:navigate",
  back: "toolbar:back",
  forward: "toolbar:forward",
  reload: "toolbar:reload",
  state: "toolbar:state",
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
};

contextBridge.exposeInMainWorld("maloToolbar", api);
