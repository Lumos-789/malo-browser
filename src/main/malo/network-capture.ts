import { DemoError } from "../../shared/errors";
import type {
  MaloNetworkCaptureState,
  MaloResponseBodyError,
  MaloResponseRecord,
  MaloResponsesResult,
} from "../../shared/malo";

/** Defaults are documented in docs/malo-browser.md and asserted by tests. */
export const NETWORK_CAPTURE_LIMITS = {
  records: 500,
  capturedBodies: 200,
  bodyBytes: 16 * 1024 * 1024,
  bodyCapBytes: 1024 * 1024,
} as const;

const NETWORK_BUFFERS = {
  maxTotalBufferSize: 64 * 1024 * 1024,
  maxResourceBufferSize: 8 * 1024 * 1024,
} as const;

export type CdpEventParams = Record<string, unknown>;

/**
 * The slice of ElectronPageDriver the capture state machine needs. Keeping it
 * narrow lets the fixture harness drive the real state machine without a
 * browser, while production always uses the driver's single debugger attach.
 */
export type CaptureTransport = {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onCdpEvent(method: string, handler: (params: CdpEventParams) => void): () => void;
};

export type NetworkCaptureOptions = {
  maxRecords?: number;
  maxCapturedBodies?: number;
  maxBodyBytes?: number;
};

type NetworkResponsePayload = {
  url?: unknown;
  status?: unknown;
  mimeType?: unknown;
};

type ResponseReceivedParams = {
  requestId?: unknown;
  type?: unknown;
  response?: NetworkResponsePayload;
};

type ResponseBodyPayload = {
  body?: unknown;
  base64Encoded?: unknown;
};

/**
 * Per-session capture state machine. It records metadata for every response,
 * queues Network.getResponseBody for subscribed hits one at a time, and keeps
 * bodies in memory only for this session.
 */
export class NetworkCapture {
  private readonly maxRecords: number;
  private readonly maxCapturedBodies: number;
  private readonly maxBodyBytes: number;
  private readonly unsubscribers: Array<() => void>;

  private prefixes: string[] = [];
  private enabled = false;
  private enabling: Promise<void> | null = null;
  private failure: string | null = null;
  private disposed = false;
  private seq = 0;
  private capturedBytes = 0;
  private readonly records: MaloResponseRecord[] = [];
  private readonly pending = new Map<string, MaloResponseRecord>();
  private bodyQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: CaptureTransport,
    options: NetworkCaptureOptions = {},
  ) {
    this.maxRecords = positiveInteger(options.maxRecords, NETWORK_CAPTURE_LIMITS.records);
    this.maxCapturedBodies = positiveInteger(
      options.maxCapturedBodies,
      NETWORK_CAPTURE_LIMITS.capturedBodies,
    );
    this.maxBodyBytes = positiveInteger(options.maxBodyBytes, NETWORK_CAPTURE_LIMITS.bodyBytes);
    this.unsubscribers = [
      transport.onCdpEvent("Network.responseReceived", (params) =>
        this.handleResponseReceived(params),
      ),
      transport.onCdpEvent("Network.loadingFinished", (params) =>
        this.handleLoadingFinished(params),
      ),
      transport.onCdpEvent("Network.loadingFailed", (params) => this.handleLoadingFailed(params)),
    ];
  }

  async setSubscription(prefixes: string[]): Promise<MaloNetworkCaptureState> {
    this.assertNotDisposed();
    if (prefixes.length === 0) {
      if (this.enabled) {
        try {
          await this.transport.send("Network.disable");
        } catch (error) {
          this.failure = `Network.disable 失败：${messageOf(error)}`;
          throw captureUnavailable(this.failure);
        }
        this.enabled = false;
      }
      this.prefixes = [];
      this.failure = null;
      this.dropBuffers();
      return this.state();
    }
    await this.enable();
    this.prefixes = [...prefixes];
    return this.state();
  }

  state(): MaloNetworkCaptureState {
    this.assertUsable();
    return { url_prefixes: [...this.prefixes], captured: this.countCapturedBodies() };
  }

  query(input: { url_prefix?: string; after?: number; limit?: number } = {}): MaloResponsesResult {
    this.assertUsable();
    const after = Number.isFinite(input.after) ? Math.max(0, Math.floor(input.after!)) : 0;
    const requested = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 50;
    const limit = Math.max(1, Math.min(200, requested));
    const matching = this.records.filter(
      (record) =>
        record.seq > after &&
        (input.url_prefix === undefined || record.url.startsWith(input.url_prefix)),
    );
    const page = matching.slice(0, limit);
    return {
      responses: page.map((record) => ({ ...record })),
      has_more: matching.length > page.length,
    };
  }

  async drain(): Promise<void> {
    await this.bodyQueue;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.pending.clear();
    this.records.length = 0;
    this.prefixes = [];
    this.capturedBytes = 0;
    this.enabled = false;
    this.failure = null;
  }

  private async enable(): Promise<void> {
    if (this.enabled) return;
    if (this.enabling === null) {
      this.enabling = this.enableNow().finally(() => {
        this.enabling = null;
      });
    }
    await this.enabling;
  }

  private async enableNow(): Promise<void> {
    try {
      await this.transport.send("Network.enable", { ...NETWORK_BUFFERS });
    } catch (error) {
      this.failure = `Network.enable 失败：${messageOf(error)}`;
      throw captureUnavailable(this.failure);
    }
    this.enabled = true;
    this.failure = null;
  }

  private handleResponseReceived(params: ResponseReceivedParams): void {
    if (!this.enabled || this.disposed) return;
    const requestId = typeof params.requestId === "string" ? params.requestId : null;
    const response = params.response;
    if (requestId === null || response === undefined || typeof response.url !== "string") return;
    const subscribed = this.matchesPrefix(response.url);
    const record: MaloResponseRecord = {
      seq: (this.seq += 1),
      url: response.url,
      status: typeof response.status === "number" ? response.status : 0,
      mime_type: typeof response.mimeType === "string" ? response.mimeType : "",
      resource_type: typeof params.type === "string" ? params.type : "",
      body: null,
      body_truncated: false,
      body_error: subscribed ? "pending" : "not_subscribed",
    };
    this.records.push(record);
    this.evictMetadata();
    if (subscribed) this.pending.set(requestId, record);
  }

  private handleLoadingFinished(params: { requestId?: unknown }): void {
    if (!this.enabled || this.disposed) return;
    const requestId = typeof params.requestId === "string" ? params.requestId : null;
    if (requestId === null) return;
    const record = this.pending.get(requestId);
    if (record === undefined) return;
    this.pending.delete(requestId);
    this.bodyQueue = this.bodyQueue
      .then(() => this.fetchBody(requestId, record))
      .catch(() => undefined);
  }

  private handleLoadingFailed(params: { requestId?: unknown; errorText?: unknown }): void {
    if (!this.enabled || this.disposed) return;
    const requestId = typeof params.requestId === "string" ? params.requestId : null;
    if (requestId === null) return;
    const record = this.pending.get(requestId);
    if (record === undefined) return;
    this.pending.delete(requestId);
    const reason = typeof params.errorText === "string" ? params.errorText : "loading failed";
    this.failRecord(record, `getResponseBody_failed: loadingFailed: ${reason}`);
  }

  private async fetchBody(requestId: string, record: MaloResponseRecord): Promise<void> {
    if (!this.canMutateBody(record)) return;
    let payload: ResponseBodyPayload;
    try {
      payload = await this.transport.send<ResponseBodyPayload>("Network.getResponseBody", {
        requestId,
      });
    } catch (error) {
      this.failRecord(record, `getResponseBody_failed: ${messageOf(error)}`);
      return;
    }
    if (!this.canMutateBody(record)) return;
    if (payload === null || typeof payload !== "object") {
      this.failRecord(record, "getResponseBody_failed: malformed response");
      return;
    }
    if (payload.base64Encoded === true) {
      this.failRecord(record, "binary");
      return;
    }
    const body = typeof payload.body === "string" ? payload.body : "";
    if (body === "") {
      this.failRecord(record, "no_body");
      return;
    }
    const truncated = truncateUtf8(body, NETWORK_CAPTURE_LIMITS.bodyCapBytes);
    record.body = truncated.body;
    record.body_truncated = truncated.truncated;
    record.body_error = null;
    this.retainBody(record);
  }

  private retainBody(record: MaloResponseRecord): void {
    if (record.body === null) return;
    this.capturedBytes += Buffer.byteLength(record.body, "utf8");
    while (
      this.countCapturedBodies() > this.maxCapturedBodies ||
      this.capturedBytes > this.maxBodyBytes
    ) {
      const oldest = this.records.find(
        (candidate) => candidate.body !== null && candidate !== record,
      );
      if (oldest === undefined) break;
      this.dropBody(oldest);
    }
    if (this.capturedBytes > this.maxBodyBytes) this.dropBody(record);
  }

  private dropBody(record: MaloResponseRecord): void {
    if (record.body === null) return;
    this.capturedBytes = Math.max(
      0,
      this.capturedBytes - Buffer.byteLength(record.body, "utf8"),
    );
    record.body = null;
    record.body_truncated = false;
    record.body_error = "evicted";
  }

  private dropBuffers(): void {
    for (const record of this.records) {
      if (record.body !== null) {
        this.dropBody(record);
        record.body_error = "not_subscribed";
      } else if (record.body_error === "pending") {
        record.body_error = "not_subscribed";
      }
    }
    this.pending.clear();
    this.capturedBytes = 0;
  }

  private evictMetadata(): void {
    while (this.records.length > this.maxRecords) {
      const oldest = this.records.shift();
      if (oldest === undefined) break;
      if (oldest.body !== null) {
        this.capturedBytes = Math.max(
          0,
          this.capturedBytes - Buffer.byteLength(oldest.body, "utf8"),
        );
      }
      for (const [requestId, record] of this.pending) {
        if (record === oldest) this.pending.delete(requestId);
      }
    }
  }

  private failRecord(record: MaloResponseRecord, reason: MaloResponseBodyError): void {
    if (!this.canMutateBody(record)) return;
    record.body = null;
    record.body_truncated = false;
    record.body_error = reason;
  }

  private canMutateBody(record: MaloResponseRecord): boolean {
    return (
      !this.disposed &&
      record.body_error === "pending" &&
      this.records.includes(record)
    );
  }

  private matchesPrefix(url: string): boolean {
    return this.prefixes.some((prefix) => url.startsWith(prefix));
  }

  private countCapturedBodies(): number {
    let count = 0;
    for (const record of this.records) if (record.body !== null) count += 1;
    return count;
  }

  private assertUsable(): void {
    this.assertNotDisposed();
    if (this.failure !== null) throw captureUnavailable(this.failure);
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new DemoError("E_SESSION_NOT_FOUND", "网络捕获已随 session 关闭");
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function captureUnavailable(reason: string): DemoError {
  return new DemoError("E_CAPTURE_UNAVAILABLE", `网络捕获不可用：${reason}`, {
    details: { reason },
  });
}

/** Caps by UTF-8 bytes so a multi-byte body still respects the documented MiB. */
function truncateUtf8(text: string, maxBytes: number): { body: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { body: text, truncated: false };
  let body = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  while (Buffer.byteLength(body, "utf8") > maxBytes) body = body.slice(0, -1);
  return { body, truncated: true };
}
