export type BrowserToolbarState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
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
