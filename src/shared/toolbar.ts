export type BrowserToolbarState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

/** 人对 agent 发的信号在面板上的样子：做完了 / 暂停中 / 已停止。 */
export type HumanPanelState = {
  done: boolean;
  paused: boolean;
  stopped: boolean;
};

export type BrowserToolbarNavigateResult = {
  ok: boolean;
  error?: string;
};

export type BrowserToolbarApi = {
  navigate(input: string): Promise<BrowserToolbarNavigateResult>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  onState(listener: (state: BrowserToolbarState) => void): () => void;
  done(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  onHuman(listener: (state: HumanPanelState) => void): () => void;
};

export function normalizeAddress(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}
