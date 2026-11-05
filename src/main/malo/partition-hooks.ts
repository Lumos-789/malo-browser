import type { Session } from "electron";

/**
 * Electron installs a single listener per `webRequest` event and a single
 * permission handler per session, and `will-download` fires for every
 * contents in the partition. Sessions that share a profile share one Electron
 * session, so each BrowserSession cannot register its own handlers: the last
 * one would win (or, for downloads, every handler would fight over the save
 * path). This module keeps one listener per Electron session and dispatches to
 * the owner of the originating webContents.
 */

export type WebRequestDetails = {
  webContentsId?: number;
  url: string;
  error?: string;
  resourceType: string;
  statusCode?: number;
};

export type DownloadItemLike = {
  getFilename(): string;
  setSavePath(path: string): void;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
};

export type DownloadEventLike = { preventDefault(): void };

export type ContentsLike = { id: number } | null;

export type PartitionHost = {
  setPermissionRequestHandler(
    handler: (
      contents: ContentsLike,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  on(
    event: "will-download",
    listener: (event: DownloadEventLike, item: DownloadItemLike, contents: ContentsLike) => void,
  ): void;
  webRequest: {
    onErrorOccurred(listener: (details: WebRequestDetails) => void): void;
    onCompleted(listener: (details: WebRequestDetails) => void): void;
  };
};

export type PartitionHook = {
  webContentsId: number;
  onPermissionRequested(permission: string): void;
  onRequestFailed(details: WebRequestDetails): void;
  onMainFrameCompleted(statusCode: number): void;
  onDownload(event: DownloadEventLike, item: DownloadItemLike): void;
};

type Hub = {
  hooks: Set<PartitionHook>;
  wired: boolean;
};

const hubs = new WeakMap<object, Hub>();

function ownerOf(hub: Hub, contentsId: number | undefined): PartitionHook | null {
  if (contentsId === undefined) return null;
  for (const hook of hub.hooks) {
    if (hook.webContentsId === contentsId) return hook;
  }
  return null;
}

function wire(host: PartitionHost, hub: Hub): void {
  host.setPermissionRequestHandler((contents, permission, callback) => {
    ownerOf(hub, contents?.id)?.onPermissionRequested(permission);
    callback(false);
  });
  host.on("will-download", (event, item, contents) => {
    const hook = ownerOf(hub, contents?.id);
    if (!hook) {
      // No session owns this download; never write anywhere by default.
      event.preventDefault();
      return;
    }
    hook.onDownload(event, item);
  });
  host.webRequest.onErrorOccurred((details) => {
    if (details.error === "net::ERR_ABORTED") return;
    ownerOf(hub, details.webContentsId)?.onRequestFailed(details);
  });
  host.webRequest.onCompleted((details) => {
    if (details.resourceType !== "mainFrame" || (details.statusCode ?? 0) <= 0) return;
    ownerOf(hub, details.webContentsId)?.onMainFrameCompleted(details.statusCode as number);
  });
}

/**
 * Registers `hook` on the Electron session and returns a detach function.
 * The first hook for a session installs the single shared listener set.
 */
export function attachPartitionHooks(
  session: Session,
  hook: PartitionHook,
): () => void {
  const key = session as unknown as object;
  let hub = hubs.get(key);
  if (!hub) {
    hub = { hooks: new Set(), wired: false };
    hubs.set(key, hub);
  }
  hub.hooks.add(hook);
  if (!hub.wired) {
    hub.wired = true;
    wire(session as unknown as PartitionHost, hub);
  }
  const attached = hub;
  return () => {
    attached.hooks.delete(hook);
  };
}
