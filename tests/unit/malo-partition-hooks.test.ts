import { describe, expect, it, vi } from "vitest";
import {
  attachPartitionHooks,
  type DownloadEventLike,
  type DownloadItemLike,
  type PartitionHost,
  type PartitionHook,
  type WebRequestDetails,
} from "../../src/main/malo/partition-hooks";

type PermissionHandler = (
  contents: { id: number } | null,
  permission: string,
  callback: (granted: boolean) => void,
) => void;
type DownloadListener = (
  event: DownloadEventLike,
  item: DownloadItemLike,
  contents: { id: number } | null,
) => void;

/**
 * Mirrors Electron's real constraint: one permission handler and one listener
 * per webRequest event, but `will-download` is a multi-listener EventEmitter.
 */
class FakePartition implements PartitionHost {
  permissionHandler: PermissionHandler | null = null;
  downloadListeners: DownloadListener[] = [];
  errorListeners: Array<(details: WebRequestDetails) => void> = [];
  completedListeners: Array<(details: WebRequestDetails) => void> = [];
  permissionRegistrations = 0;
  errorRegistrations = 0;

  readonly webRequest = {
    onErrorOccurred: (listener: (details: WebRequestDetails) => void) => {
      this.errorListeners = [listener];
      this.errorRegistrations += 1;
    },
    onCompleted: (listener: (details: WebRequestDetails) => void) => {
      this.completedListeners = [listener];
    },
  };

  setPermissionRequestHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler;
    this.permissionRegistrations += 1;
  }

  on(_event: "will-download", listener: DownloadListener): void {
    this.downloadListeners.push(listener);
  }

  requestPermission(contentsId: number | null, permission: string): boolean {
    let granted = true;
    this.permissionHandler?.(
      contentsId === null ? null : { id: contentsId },
      permission,
      (value) => {
        granted = value;
      },
    );
    return granted;
  }

  download(contentsId: number | null, item: DownloadItemLike): boolean {
    let prevented = false;
    const event: DownloadEventLike = { preventDefault: () => { prevented = true; } };
    for (const listener of this.downloadListeners) {
      listener(event, item, contentsId === null ? null : { id: contentsId });
    }
    return prevented;
  }

  requestFailed(details: WebRequestDetails): void {
    for (const listener of this.errorListeners) listener(details);
  }

  mainFrameCompleted(webContentsId: number, statusCode: number): void {
    for (const listener of this.completedListeners) {
      listener({ webContentsId, statusCode, url: "http://demo.test/", resourceType: "mainFrame" });
    }
  }
}

function makeHook(webContentsId: number) {
  const calls = {
    permissions: [] as string[],
    failures: [] as WebRequestDetails[],
    completed: [] as number[],
    savePaths: [] as string[],
  };
  const hook: PartitionHook = {
    webContentsId,
    onPermissionRequested: (permission) => calls.permissions.push(permission),
    onRequestFailed: (details) => calls.failures.push(details),
    onMainFrameCompleted: (statusCode) => calls.completed.push(statusCode),
    onDownload: (_event, item) => {
      const target = `/downloads/${webContentsId}-${item.getFilename()}`;
      item.setSavePath(target);
      calls.savePaths.push(target);
    },
  };
  return { hook, calls };
}

function makeItem(filename: string): DownloadItemLike & { savePath: string | null } {
  return {
    savePath: null,
    getFilename: () => filename,
    setSavePath(path: string) {
      this.savePath = path;
    },
    once: vi.fn(),
  };
}

describe("partition hooks", () => {
  it("installs one listener set per Electron session even with several sessions", () => {
    const partition = new FakePartition();
    attachPartitionHooks(partition as never, makeHook(1).hook);
    attachPartitionHooks(partition as never, makeHook(2).hook);

    expect(partition.permissionRegistrations).toBe(1);
    expect(partition.errorRegistrations).toBe(1);
    expect(partition.downloadListeners).toHaveLength(1);
  });

  it("dispatches requests to the session that owns the webContents", () => {
    const partition = new FakePartition();
    const first = makeHook(1);
    const second = makeHook(2);
    attachPartitionHooks(partition as never, first.hook);
    attachPartitionHooks(partition as never, second.hook);

    partition.requestFailed({
      webContentsId: 2,
      url: "http://demo.test/a",
      error: "net::ERR_FAILED",
      resourceType: "image",
    });
    partition.mainFrameCompleted(2, 404);
    partition.requestFailed({
      webContentsId: 1,
      url: "http://demo.test/b",
      error: "net::ERR_ABORTED",
      resourceType: "image",
    });

    expect(first.calls.failures).toHaveLength(0);
    expect(second.calls.failures).toHaveLength(1);
    expect(first.calls.completed).toHaveLength(0);
    expect(second.calls.completed).toEqual([404]);
  });

  it("always denies permission requests and only notifies the owner", () => {
    const partition = new FakePartition();
    const first = makeHook(1);
    attachPartitionHooks(partition as never, first.hook);

    expect(partition.requestPermission(1, "geolocation")).toBe(false);
    expect(partition.requestPermission(99, "geolocation")).toBe(false);
    expect(first.calls.permissions).toEqual(["geolocation"]);
  });

  it("writes a download into the owning session and refuses an unowned one", () => {
    const partition = new FakePartition();
    const first = makeHook(1);
    const second = makeHook(2);
    attachPartitionHooks(partition as never, first.hook);
    attachPartitionHooks(partition as never, second.hook);

    const item = makeItem("report.txt");
    partition.download(1, item);
    expect(item.savePath).toBe("/downloads/1-report.txt");
    expect(first.calls.savePaths).toEqual(["/downloads/1-report.txt"]);
    expect(second.calls.savePaths).toHaveLength(0);

    const orphan = makeItem("escape.txt");
    expect(partition.download(99, orphan)).toBe(true);
    expect(orphan.savePath).toBeNull();
  });

  it("stops dispatching after the detach function runs", () => {
    const partition = new FakePartition();
    const first = makeHook(1);
    const detach = attachPartitionHooks(partition as never, first.hook);

    partition.requestFailed({
      webContentsId: 1,
      url: "http://demo.test/a",
      error: "net::ERR_FAILED",
      resourceType: "image",
    });
    detach();
    partition.requestFailed({
      webContentsId: 1,
      url: "http://demo.test/b",
      error: "net::ERR_FAILED",
      resourceType: "image",
    });

    expect(first.calls.failures).toHaveLength(1);
  });
});
