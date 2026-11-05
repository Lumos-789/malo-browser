import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NETWORK_CAPTURE_LIMITS,
  NetworkCapture,
  type CaptureTransport,
} from "../../src/main/malo/network-capture";

const ITEMS_BODY =
  '{"code":0,"items":[{"id":1,"name":"alpha"},{"id":2,"name":"beta"}],"note":"fixture"}';
const LARGE_BODY = JSON.stringify({ blob: "x".repeat(1024 * 1024 + 4096) });
const BINARY_BODY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff, 0x00, 0x10]);
const PAD_BODY = "p".repeat(200);

type CdpParams = Record<string, unknown>;
type CdpHandler = (params: CdpParams) => void;

/**
 * Chromium's Network domain is not reachable from vitest (Electron is not the
 * test runtime), so this transport plays the CDP side while every response body
 * still comes from a real loopback HTTP request to the fixture server. The
 * fixture page's buttons name their endpoint in `data-xhr`, which lets a test
 * express subscribe -> navigate -> click -> responses without a browser window.
 */
class FakeCdp implements CaptureTransport {
  private readonly handlers = new Map<string, Set<CdpHandler>>();
  readonly payloads = new Map<string, { body: string; base64Encoded: boolean }>();
  readonly commands: string[] = [];
  enableParams: Record<string, unknown> | null = null;
  enableCalls = 0;
  disableCalls = 0;
  bodyCalls = 0;
  maxBodyCallsInFlight = 0;
  failEnable: string | null = null;
  failDisable: string | null = null;
  failBody: string | null = null;
  bodyDelayMs = 0;
  bodyBarrier: Promise<void> | null = null;
  private inFlight = 0;

  onCdpEvent(method: string, handler: CdpHandler): () => void {
    const handlers = this.handlers.get(method) ?? new Set<CdpHandler>();
    handlers.add(handler);
    this.handlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  async send<T = unknown>(method: string, params: CdpParams = {}): Promise<T> {
    this.commands.push(method);
    if (method === "Network.enable") {
      this.enableCalls += 1;
      if (this.failEnable !== null) throw new Error(this.failEnable);
      this.enableParams = { ...params };
      return {} as T;
    }
    if (method === "Network.disable") {
      this.disableCalls += 1;
      if (this.failDisable !== null) throw new Error(this.failDisable);
      return {} as T;
    }
    if (method === "Network.getResponseBody") {
      this.bodyCalls += 1;
      this.inFlight += 1;
      this.maxBodyCallsInFlight = Math.max(this.maxBodyCallsInFlight, this.inFlight);
      try {
        if (this.bodyBarrier !== null) await this.bodyBarrier;
        if (this.bodyDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.bodyDelayMs));
        }
        if (this.failBody !== null) {
          const reason = this.failBody;
          this.failBody = null;
          throw new Error(reason);
        }
        const payload = this.payloads.get(String(params.requestId));
        if (!payload) throw new Error("No resource with given identifier");
        return { ...payload } as T;
      } finally {
        this.inFlight -= 1;
      }
    }
    throw new Error(`unexpected CDP command: ${method}`);
  }

  emit(method: string, params: CdpParams): void {
    for (const handler of this.handlers.get(method) ?? []) handler(params);
  }

  handlerCount(method: string): number {
    return this.handlers.get(method)?.size ?? 0;
  }
}

class FixtureNetwork {
  private counter = 0;

  constructor(
    readonly cdp: FakeCdp,
    readonly base: string,
  ) {}

  async request(pathname: string, type: string): Promise<string> {
    const url = new URL(pathname, this.base).toString();
    const response = await fetch(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    // CDP reports the media type only, without the charset parameter.
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim();
    const binary =
      mime !== "" && !/^(?:text\/|application\/(?:json|javascript|xml))/.test(mime);
    const requestId = `request-${++this.counter}`;
    this.cdp.payloads.set(requestId, {
      body: binary ? bytes.toString("base64") : bytes.toString("utf8"),
      base64Encoded: binary,
    });
    this.cdp.emit("Network.responseReceived", {
      requestId,
      type,
      response: { url, status: response.status, mimeType: mime },
    });
    return requestId;
  }

  finish(requestId: string): void {
    this.cdp.emit("Network.loadingFinished", { requestId });
  }

  async complete(pathname: string, type: string): Promise<string> {
    const requestId = await this.request(pathname, type);
    this.finish(requestId);
    return requestId;
  }

  async navigate(): Promise<void> {
    await this.complete("/", "Document");
  }

  async click(pageHtml: string, buttonId: string): Promise<string> {
    return this.complete(xhrFor(pageHtml, buttonId), "XHR");
  }
}

function xhrFor(html: string, buttonId: string): string {
  const match = new RegExp(`id="${buttonId}"[^>]*data-xhr="([^"]+)"`).exec(html);
  if (!match) throw new Error(`fixture page is missing button ${buttonId}`);
  return match[1];
}

let server: Server;
let base = "";
let pageHtml = "";

beforeAll(async () => {
  pageHtml = await readFile(
    fileURLToPath(new URL("../../fixtures/pages/network-capture.html", import.meta.url)),
    "utf8",
  );
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(pageHtml);
      return;
    }
    if (url.pathname === "/api/items") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(ITEMS_BODY);
      return;
    }
    if (url.pathname === "/api/large") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(LARGE_BODY);
      return;
    }
    if (url.pathname === "/api/pad") {
      const size = Math.min(2 * 1024 * 1024, Number(url.searchParams.get("size") ?? "0"));
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(PAD_BODY.slice(0, size));
      return;
    }
    if (url.pathname === "/api/binary" || url.pathname === "/api/pixel.png") {
      response.writeHead(200, {
        "content-type": url.pathname.endsWith(".png") ? "image/png" : "application/octet-stream",
      });
      response.end(BINARY_BODY);
      return;
    }
    if (url.pathname === "/api/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("network capture", () => {
  it("captures a clicked XHR body byte-for-byte from the fixture server", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/items`]);
    await network.navigate();
    await network.click(pageHtml, "load-items");
    await capture.drain();

    const { responses, has_more } = capture.query({});
    expect(has_more).toBe(false);
    expect(responses.map((record) => record.seq)).toEqual([1, 2]);
    expect(responses[0]).toMatchObject({
      url: `${base}/`,
      resource_type: "Document",
      body: null,
      body_error: "not_subscribed",
    });
    const hit = responses[1];
    expect(hit.url).toBe(`${base}/api/items`);
    expect(hit.status).toBe(200);
    expect(hit.mime_type).toBe("application/json");
    expect(hit.resource_type).toBe("XHR");
    expect(hit.body).toBe(ITEMS_BODY);
    expect(hit.body).not.toBeNull();
    expect(hit.body_truncated).toBe(false);
    expect(hit.body_error).toBeNull();
    expect(capture.state()).toEqual({
      url_prefixes: [`${base}/api/items`],
      captured: 1,
    });
    capture.dispose();
  });

  it("truncates a body over 1 MiB and keeps exactly the byte cap", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/large`]);
    await network.navigate();
    await network.click(pageHtml, "load-large");
    await capture.drain();

    const record = capture.query({}).responses[1];
    expect(record.body_truncated).toBe(true);
    expect(record.body_error).toBeNull();
    expect(record.body).toBe(LARGE_BODY.slice(0, NETWORK_CAPTURE_LIMITS.bodyCapBytes));
    expect(record.body?.length).toBe(1024 * 1024);
    expect(LARGE_BODY.length).toBeGreaterThan(1024 * 1024);
    capture.dispose();
  });

  it("keeps metadata but no body for an unsubscribed XHR", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/other`]);
    await network.complete("/api/items", "XHR");
    await capture.drain();

    const record = capture.query({}).responses[0];
    expect(record).toMatchObject({
      url: `${base}/api/items`,
      status: 200,
      resource_type: "XHR",
      body: null,
      body_error: "not_subscribed",
      body_truncated: false,
    });
    expect(cdp.bodyCalls).toBe(0);
    capture.dispose();
  });

  it("reports an empty 2xx body as no_body instead of an empty string", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/`]);
    await network.complete("/api/empty", "Fetch");
    await capture.drain();

    expect(capture.query({}).responses[0]).toMatchObject({
      status: 204,
      body: null,
      body_error: "no_body",
    });
    capture.dispose();
  });

  it("applies after, limit and has_more over matching records", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/`]);
    for (let index = 0; index < 5; index += 1) {
      await network.complete(`/api/items?v=${index}`, "XHR");
    }
    await capture.drain();

    const all = capture.query({});
    expect(all.responses).toHaveLength(5);
    expect(all.responses.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(all.has_more).toBe(false);

    const window = capture.query({ after: 2, limit: 2 });
    expect(window.responses.map((record) => record.seq)).toEqual([3, 4]);
    expect(window.has_more).toBe(true);

    const tail = capture.query({ after: 5 });
    expect(tail.responses).toEqual([]);
    expect(tail.has_more).toBe(false);

    const filtered = capture.query({ url_prefix: `${base}/api/items?v=3` });
    expect(filtered.responses.map((record) => record.seq)).toEqual([4]);
    capture.dispose();
  });

  it("starts each session at seq 1 and never crosses records", async () => {
    const cdpA = new FakeCdp();
    const cdpB = new FakeCdp();
    const networkA = new FixtureNetwork(cdpA, base);
    const networkB = new FixtureNetwork(cdpB, base);
    const captureA = new NetworkCapture(cdpA);
    const captureB = new NetworkCapture(cdpB);

    await Promise.all([
      captureA.setSubscription([`${base}/api/items`]),
      captureB.setSubscription([`${base}/api/bin`]),
    ]);
    await Promise.all([
      networkA.complete("/api/items", "XHR"),
      networkB.complete("/api/binary", "XHR"),
    ]);
    await Promise.all([captureA.drain(), captureB.drain()]);

    const recordsA = captureA.query({}).responses;
    const recordsB = captureB.query({}).responses;
    expect(recordsA.map((record) => record.seq)).toEqual([1]);
    expect(recordsB.map((record) => record.seq)).toEqual([1]);
    expect(recordsA[0].url).toBe(`${base}/api/items`);
    expect(recordsA[0].body).toBe(ITEMS_BODY);
    expect(recordsB[0].url).toBe(`${base}/api/binary`);
    expect(recordsB[0].body_error).toBe("binary");
    expect(recordsA[0].body_error).toBeNull();
    captureA.dispose();
    captureB.dispose();
  });

  it("marks a base64 response as binary instead of decoding it", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/`]);
    await network.complete("/api/binary", "XHR");
    await capture.drain();

    const record = capture.query({}).responses[0];
    expect(record.mime_type).toBe("application/octet-stream");
    expect(record.body).toBeNull();
    expect(record.body_error).toBe("binary");
    expect(record.body_truncated).toBe(false);
    capture.dispose();
  });

  it("exposes pending until loadingFinished delivers the body", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/items`]);
    const requestId = await network.request("/api/items", "XHR");

    expect(capture.query({}).responses[0]).toMatchObject({
      body: null,
      body_error: "pending",
    });

    network.finish(requestId);
    await capture.drain();
    expect(capture.query({}).responses[0]).toMatchObject({
      body: ITEMS_BODY,
      body_error: null,
    });
    capture.dispose();
  });

  it("fetches bodies one at a time", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);
    cdp.bodyDelayMs = 5;

    await capture.setSubscription([`${base}/api/`]);
    for (let index = 0; index < 3; index += 1) {
      await network.complete(`/api/items?v=${index}`, "XHR");
    }
    await capture.drain();

    expect(cdp.bodyCalls).toBe(3);
    expect(cdp.maxBodyCallsInFlight).toBe(1);
    capture.dispose();
  });

  it("does not resurrect a body whose fetch was in flight when the subscription cleared", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);
    let release = () => {};
    cdp.bodyBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });

    await capture.setSubscription([`${base}/api/items`]);
    const requestId = await network.request("/api/items", "XHR");
    network.finish(requestId);
    while (cdp.bodyCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    await capture.setSubscription([]);
    release();
    await capture.drain();

    const record = capture.query({}).responses[0];
    expect(record).toMatchObject({ body: null, body_error: "not_subscribed" });
    expect(cdp.bodyCalls).toBe(1);
    capture.dispose();
  });

  it("surfaces a getResponseBody failure once without retrying", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/items`]);
    cdp.failBody = "No resource with given identifier";
    await network.complete("/api/items", "XHR");
    await capture.drain();

    const record = capture.query({}).responses[0];
    expect(record.body).toBeNull();
    expect(record.body_error).toBe(
      "getResponseBody_failed: No resource with given identifier",
    );
    expect(cdp.bodyCalls).toBe(1);
    capture.dispose();
  });

  it("evicts the oldest body when the captured-body cap is reached", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/items`]);
    for (let index = 0; index < 201; index += 1) {
      await network.complete(`/api/items?v=${index}`, "XHR");
    }
    await capture.drain();

    expect(capture.state().captured).toBe(NETWORK_CAPTURE_LIMITS.capturedBodies);
    const records = capture.query({ limit: 200 }).responses;
    expect(records).toHaveLength(200);
    expect(records[0].seq).toBe(1);
    expect(records[0].body).toBeNull();
    expect(records[0].body_error).toBe("evicted");
    expect(records[0].body_truncated).toBe(false);

    const newest = capture.query({ after: 200 }).responses;
    expect(newest.map((record) => record.seq)).toEqual([201]);
    expect(newest[0].body).toBe(ITEMS_BODY);
    capture.dispose();
  });

  it("evicts the oldest body when the byte budget is exceeded", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp, { maxBodyBytes: 300 });

    await capture.setSubscription([`${base}/api/pad`]);
    await network.complete("/api/pad?size=200", "XHR");
    await network.complete("/api/pad?size=200", "XHR");
    await capture.drain();

    const records = capture.query({}).responses;
    expect(records[0]).toMatchObject({
      seq: 1,
      body: null,
      body_error: "evicted",
    });
    expect(records[1]).toMatchObject({
      seq: 2,
      body: PAD_BODY,
      body_error: null,
    });
    expect(capture.state().captured).toBe(1);
    capture.dispose();
  });

  it("keeps the metadata window at 500 so image floods cannot evict a JSON body", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/items`]);
    for (let index = 0; index < 500; index += 1) {
      const requestId = `image-${index}`;
      cdp.payloads.set(requestId, { body: "", base64Encoded: false });
      cdp.emit("Network.responseReceived", {
        requestId,
        type: "Image",
        response: {
          url: `${base}/image-${index}.png`,
          status: 200,
          mimeType: "image/png",
        },
      });
      cdp.emit("Network.loadingFinished", { requestId });
    }
    await network.complete("/api/items", "XHR");
    await capture.drain();

    expect(capture.query({ after: 500 }).responses.map((record) => record.seq)).toEqual([
      501,
    ]);
    expect(capture.query({ after: 500 }).responses[0].body).toBe(ITEMS_BODY);
    const retained = capture.query({ limit: 200 }).responses;
    expect(retained[0].seq).toBe(2);
    expect(retained[retained.length - 1].seq).toBe(201);
    const tail = capture.query({ after: 400, limit: 200 }).responses;
    expect(tail[tail.length - 1].seq).toBe(501);
    capture.dispose();
  });

  it("fails loud when the capture domain cannot be enabled", async () => {
    const cdp = new FakeCdp();
    const capture = new NetworkCapture(cdp);
    cdp.failEnable = "Network.enable quota exceeded";

    await expect(capture.setSubscription([`${base}/api/items`])).rejects.toMatchObject({
      code: "E_CAPTURE_UNAVAILABLE",
    });
    expect(() => capture.query({})).toThrow(/Network.enable quota exceeded/);
    expect(() => capture.state()).toThrow(/Network.enable quota exceeded/);

    await expect(capture.setSubscription([])).resolves.toEqual({
      url_prefixes: [],
      captured: 0,
    });
    expect(capture.query({}).responses).toEqual([]);
    capture.dispose();
  });

  it("recovers when a failed disable is followed by a new subscription", async () => {
    const cdp = new FakeCdp();
    const capture = new NetworkCapture(cdp);

    await capture.setSubscription([`${base}/api/`]);
    cdp.failDisable = "Network.disable rejected";
    await expect(capture.setSubscription([])).rejects.toMatchObject({
      code: "E_CAPTURE_UNAVAILABLE",
    });

    // The session must not be stuck: clearing the subscription again retries
    // the disable, and subscribing again re-enables and clears the failure.
    cdp.failDisable = null;
    await expect(capture.setSubscription([])).resolves.toEqual({
      url_prefixes: [],
      captured: 0,
    });
    cdp.failEnable = null;
    const state = await capture.setSubscription([`${base}/api/`]);
    expect(state.url_prefixes).toEqual([`${base}/api/`]);
    expect(() => capture.state()).not.toThrow();
    capture.dispose();
  });

  it("enables the domain lazily once and disables it when the subscription clears", async () => {
    const cdp = new FakeCdp();
    const network = new FixtureNetwork(cdp, base);
    const capture = new NetworkCapture(cdp);

    expect(capture.state()).toEqual({ url_prefixes: [], captured: 0 });
    expect(cdp.enableCalls).toBe(0);

    await capture.setSubscription([`${base}/api/items`]);
    await capture.setSubscription([`${base}/api/items`, `${base}/api/large`]);
    expect(cdp.enableCalls).toBe(1);
    expect(cdp.enableParams).toEqual({
      maxTotalBufferSize: 64 * 1024 * 1024,
      maxResourceBufferSize: 8 * 1024 * 1024,
    });
    expect(capture.state().url_prefixes).toEqual([
      `${base}/api/items`,
      `${base}/api/large`,
    ]);

    await network.complete("/api/items", "XHR");
    await capture.drain();
    expect(capture.state().captured).toBe(1);

    await capture.setSubscription([]);
    expect(cdp.disableCalls).toBe(1);
    expect(capture.state()).toEqual({ url_prefixes: [], captured: 0 });
    expect(capture.query({}).responses[0]).toMatchObject({
      body: null,
      body_error: "not_subscribed",
    });

    await capture.setSubscription([`${base}/api/items`]);
    expect(cdp.enableCalls).toBe(2);
    capture.dispose();
  });

  it("unsubscribes its CDP handlers on dispose", () => {
    const cdp = new FakeCdp();
    const capture = new NetworkCapture(cdp);
    expect(cdp.handlerCount("Network.responseReceived")).toBe(1);
    expect(cdp.handlerCount("Network.loadingFinished")).toBe(1);
    capture.dispose();
    expect(cdp.handlerCount("Network.responseReceived")).toBe(0);
    expect(cdp.handlerCount("Network.loadingFinished")).toBe(0);
  });

  it("publishes the documented default caps", () => {
    expect(NETWORK_CAPTURE_LIMITS).toEqual({
      records: 500,
      capturedBodies: 200,
      bodyBytes: 16 * 1024 * 1024,
      bodyCapBytes: 1024 * 1024,
    });
  });
});
