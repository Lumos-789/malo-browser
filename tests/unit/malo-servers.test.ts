import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MaloLease, MaloSessionEvent } from "../../src/shared/malo";
import { DemoError } from "../../src/shared/errors";
import { startBrokerServer, type BrokerServer } from "../../src/main/malo/broker-server";
import { LeaseManager } from "../../src/main/malo/lease-manager";
import { startLeaseServer, type LeaseServer } from "../../src/main/malo/lease-server";
import type { SessionManager } from "../../src/main/malo/session-manager";

const BROKER_TOKEN = "broker-token-0123456789abcdef";
const LEASE_TOKEN = "lease-token-0123456789abcdef";
const SESSION_A = "session-a-token-0123456789";
const SESSION_B = "session-b-token-0123456789";

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const servers: Array<BrokerServer | LeaseServer> = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

function brokerHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${BROKER_TOKEN}`,
    "content-type": "application/json",
  };
}

function leaseHeaders(): Record<string, string> {
  return {
    "x-malo-lease-token": LEASE_TOKEN,
    "content-type": "application/json",
  };
}

function sessionHeaders(token: string): Record<string, string> {
  return { ...leaseHeaders(), "x-malo-session-token": token };
}

async function startBrokerHarness(): Promise<{
  server: BrokerServer;
  manager: LeaseManager;
  lease: MaloLease;
}> {
  const manager = new LeaseManager(60_000);
  let lease: MaloLease | null = null;
  const server = await startBrokerServer({
    port: 0,
    token: BROKER_TOKEN,
    createLease: async (agentId) => {
      const record = manager.create(agentId, 7411);
      lease = {
        lease_id: record.id,
        agent_id: record.agentId,
        endpoint: `http://127.0.0.1:${record.port}`,
        token: record.token,
        expires_at: new Date(record.expiresAtMs).toISOString(),
      };
      return lease;
    },
    heartbeat: (id) => {
      try {
        return manager.heartbeat(id);
      } catch {
        throw new DemoError("E_LEASE_NOT_FOUND", `lease 不存在：${id}`);
      }
    },
    release: async (id) => {
      if (!manager.remove(id)) throw new DemoError("E_LEASE_NOT_FOUND", `lease 不存在：${id}`);
    },
    list: () =>
      manager.list().map((record) => ({
        lease_id: record.id,
        agent_id: record.agentId,
        endpoint: `http://127.0.0.1:${record.port}`,
        token: record.token,
        expires_at: new Date(record.expiresAtMs).toISOString(),
      })),
    state: () => ({ service: "malo-daemon", leases: manager.list().length }),
  });
  servers.push(server);
  return {
    server,
    manager,
    get lease() {
      if (!lease) throw new Error("lease 尚未创建");
      return lease;
    },
  };
}

describe("broker server", () => {
  it("serves health without a token and rejects foreign hosts", async () => {
    const { server } = await startBrokerHarness();
    const health = await request(server.port, { path: "/health" });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: "ok", service: "malo-broker" });

    const foreign = await request(server.port, {
      path: "/health",
      headers: { host: "evil.example.com" },
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error.code).toBe("E_CONTROL_FORBIDDEN");
  });

  it("requires the broker token for control routes", async () => {
    const { server } = await startBrokerHarness();
    const missing = await request(server.port, { path: "/v1/state" });
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.body).error.code).toBe("E_CONTROL_UNAUTHORIZED");

    const wrong = await request(server.port, {
      path: "/v1/leases",
      headers: { "x-malo-broker-token": "nope" },
    });
    expect(wrong.status).toBe(401);

    const ok = await request(server.port, {
      path: "/v1/leases",
      headers: { "x-malo-broker-token": BROKER_TOKEN },
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ leases: [] });
  });

  it("creates, renews and revokes a lease", async () => {
    const harness = await startBrokerHarness();
    const created = await request(harness.server.port, {
      method: "POST",
      path: "/v1/leases",
      headers: brokerHeaders(),
      body: JSON.stringify({ agent_id: "agent-a" }),
    });
    expect(created.status).toBe(201);
    const lease = JSON.parse(created.body) as MaloLease;
    expect(lease.agent_id).toBe("agent-a");
    expect(lease.endpoint).toBe("http://127.0.0.1:7411");
    expect(lease.token).toMatch(/^[0-9a-f]{64}$/);

    const heartbeat = await request(harness.server.port, {
      method: "POST",
      path: `/v1/leases/${lease.lease_id}/heartbeat`,
      headers: brokerHeaders(),
    });
    expect(heartbeat.status).toBe(200);
    expect(JSON.parse(heartbeat.body).lease_id).toBe(lease.lease_id);

    const released = await request(harness.server.port, {
      method: "DELETE",
      path: `/v1/leases/${lease.lease_id}`,
      headers: brokerHeaders(),
    });
    expect(released.status).toBe(200);
    expect(harness.manager.list()).toEqual([]);

    const gone = await request(harness.server.port, {
      method: "POST",
      path: `/v1/leases/${lease.lease_id}/heartbeat`,
      headers: brokerHeaders(),
    });
    expect(gone.status).toBe(404);
    expect(JSON.parse(gone.body).error.code).toBe("E_LEASE_NOT_FOUND");
  });

  it("rejects malformed lease requests with explicit client errors", async () => {
    const { server } = await startBrokerHarness();
    const noBody = await request(server.port, {
      method: "POST",
      path: "/v1/leases",
      headers: brokerHeaders(),
    });
    expect(noBody.status).toBe(400);
    expect(JSON.parse(noBody.body).error.code).toBe("E_BAD_REQUEST");

    const wrongType = await request(server.port, {
      method: "POST",
      path: "/v1/leases",
      headers: { ...brokerHeaders(), "content-type": "text/plain" },
      body: JSON.stringify({ agent_id: "agent-a" }),
    });
    expect(wrongType.status).toBe(400);

    const emptyId = await request(server.port, {
      method: "POST",
      path: "/v1/leases",
      headers: brokerHeaders(),
      body: JSON.stringify({ agent_id: "  " }),
    });
    expect(emptyId.status).toBe(400);
    expect(JSON.parse(emptyId.body).error.message).toContain("agent_id");
  });
});

type FakeSession = {
  id: string;
  token: string;
  summary(): Record<string, string>;
  navigate: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
  act: ReturnType<typeof vi.fn>;
  eventsAfter: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
  assertExpectations: ReturnType<typeof vi.fn>;
  watch: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
  networkCapture: ReturnType<typeof vi.fn>;
  responses: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function fakeSession(id: string, token: string): FakeSession {
  const summary = {
    session_id: id,
    name: id,
    profile: null,
    url: "about:blank",
    title: "",
    created_at: "2026-11-03T00:00:00.000Z",
    last_used_at: "2026-11-03T00:00:00.000Z",
  };
  return {
    id,
    token,
    summary: () => ({ ...summary }),
    navigate: vi.fn(async (url: string) => ({ ...summary, url, body_text: "" })),
    observe: vi.fn(async () => ({ ...summary, body_text: "", screenshot: { mime_type: "image/png", base64: "" } })),
    act: vi.fn(async (action: { type: string }) => ({ action: action.type, detail: "ok", observation: summary })),
    eventsAfter: vi.fn((after: number): MaloSessionEvent[] => [
      { seq: after + 1, at: "2026-11-03T00:00:00.000Z", type: "session.created" },
    ]),
    snapshot: vi.fn(async () => ({
      url: summary.url,
      title: "",
      text: "hello",
      links: [],
      truncated: {},
    })),
    extract: vi.fn(async () => ({
      selector: "#x",
      mode: "text",
      count: 1,
      matches: [],
      truncated: false,
    })),
    assertExpectations: vi.fn(async () => ({
      ok: true,
      passed: true,
      checks: [{ kind: "visible", expected: true, actual: true, ok: true }],
      url: summary.url,
      title: summary.title,
      waited_ms: 3,
    })),
    watch: vi.fn(async () => ({
      visible: true,
      focused: false,
      url: "about:blank",
      title: "",
      window: "shown",
    })),
    login: vi.fn(async (input: { mode?: string }) => ({
      mode: input.mode === "watch" ? "watch" : "password",
      ok: true,
      reason: "success",
      final_url: "http://127.0.0.1/dashboard",
      title: "Dashboard",
      credentials_used: input.mode !== "watch",
      attempts: 1,
      observation: {
        url: "http://127.0.0.1/dashboard",
        title: "Dashboard",
        body_text: "",
      },
    })),
    networkCapture: vi.fn(async (input: { url_prefixes?: string[] } = {}) => ({
      url_prefixes: input.url_prefixes ?? [],
      captured: 0,
    })),
    responses: vi.fn(async () => ({ responses: [], has_more: false })),
    close: vi.fn(async () => undefined),
  };
}

async function startLeaseHarness(): Promise<{
  server: LeaseServer;
  sessions: Map<string, FakeSession>;
  manager: SessionManager;
}> {
  const sessions = new Map<string, FakeSession>([
    ["session-a", fakeSession("session-a", SESSION_A)],
    ["session-b", fakeSession("session-b", SESSION_B)],
  ]);
  let created = 0;
  const manager = {
    create: vi.fn(async (input: { profile?: string } = {}) => {
      created += 1;
      return {
        ...sessions.get("session-a")!.summary(),
        session_id: `session-new-${created}`,
        profile: input.profile ?? null,
        session_token: "new-token",
        downloads_dir: "/tmp/downloads",
        artifacts_dir: "/tmp/artifacts",
      };
    }),
    list: vi.fn(() => [...sessions.values()].map((session) => session.summary())),
    get: vi.fn((id: string) => {
      const session = sessions.get(id);
      if (!session) throw new DemoError("E_SESSION_NOT_FOUND", `session 不存在：${id}`);
      return session;
    }),
    close: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    closeAll: vi.fn(async () => undefined),
    reapIdle: vi.fn(async () => []),
    listProfiles: vi.fn(async () => [
      {
        name: "work",
        created_at: "2026-11-03T00:00:00.000Z",
        last_used_at: "2026-11-03T00:00:00.000Z",
        sessions: 2,
        active_sessions: 0,
      },
    ]),
    clearProfile: vi.fn(async (name: string) => ({ profile: name, existed: true })),
    importProfileLogin: vi.fn(async (name: string, input: { cdp_url: string }) => ({
      profile: name,
      created: true,
      source: input.cdp_url,
      cookies_total: 10,
      cookies_matched: 4,
      cookies_written: 4,
      cookies_failed: 0,
      failed: [],
    })),
  } as unknown as SessionManager;

  const server = await startLeaseServer({
    port: 0,
    token: LEASE_TOKEN,
    leaseId: "lease-test",
    agentId: "agent-a",
    manager,
    sessionIdleMs: 60_000,
  });
  servers.push(server);
  return { server, sessions, manager };
}

describe("lease server", () => {
  it("keeps the lease token separate from per-session tokens", async () => {
    const { server } = await startLeaseHarness();
    const health = await request(server.port, { path: "/health" });
    expect(health.status).toBe(200);
    const healthBody = JSON.parse(health.body);
    expect(healthBody.service).toBe("malo-lease");
    // Health stays unauthenticated, so it must not enumerate leases/agents.
    expect(healthBody.lease_id).toBeUndefined();
    expect(healthBody.agent_id).toBeUndefined();

    const noLease = await request(server.port, { path: "/v1/sessions" });
    expect(noLease.status).toBe(401);

    const list = await request(server.port, { path: "/v1/sessions", headers: leaseHeaders() });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).sessions).toHaveLength(2);

    const noSession = await request(server.port, {
      path: "/v1/sessions/session-a",
      headers: leaseHeaders(),
    });
    expect(noSession.status).toBe(401);

    const wrongSession = await request(server.port, {
      path: "/v1/sessions/session-a",
      headers: sessionHeaders(SESSION_B),
    });
    expect(wrongSession.status).toBe(401);

    const scoped = await request(server.port, {
      path: "/v1/sessions/session-a",
      headers: sessionHeaders(SESSION_A),
    });
    expect(scoped.status).toBe(200);
    expect(JSON.parse(scoped.body).session_id).toBe("session-a");
  });

  it("navigates, observes, acts and streams events on the scoped session", async () => {
    const { server } = await startLeaseHarness();
    const navigate = await request(server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/navigate",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ url: "http://127.0.0.1:4788/index.html" }),
    });
    expect(navigate.status).toBe(200);
    expect(JSON.parse(navigate.body).url).toBe("http://127.0.0.1:4788/index.html");

    const observe = await request(server.port, {
      path: "/v1/sessions/session-a/observe?mode=screenshot&max_chars=120",
      headers: sessionHeaders(SESSION_A),
    });
    expect(observe.status).toBe(200);
    expect(JSON.parse(observe.body).screenshot.mime_type).toBe("image/png");

    const act = await request(server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/actions",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ action: { type: "click", selector: "#submit" } }),
    });
    expect(act.status).toBe(200);
    expect(JSON.parse(act.body).action).toBe("click");

    const events = await request(server.port, {
      path: "/v1/sessions/session-a/events?after=3&limit=1",
      headers: sessionHeaders(SESSION_A),
    });
    expect(events.status).toBe(200);
    expect(JSON.parse(events.body).events[0].seq).toBe(4);
  });

  it("returns explicit errors for bad observations and actions", async () => {
    const { server } = await startLeaseHarness();
    const badMode = await request(server.port, {
      path: "/v1/sessions/session-a/observe?mode=video",
      headers: sessionHeaders(SESSION_A),
    });
    expect(badMode.status).toBe(400);
    expect(JSON.parse(badMode.body).error.code).toBe("E_BAD_REQUEST");

    const badChars = await request(server.port, {
      path: "/v1/sessions/session-a/observe?max_chars=999999",
      headers: sessionHeaders(SESSION_A),
    });
    expect(badChars.status).toBe(400);

    const badAction = await request(server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/actions",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ action: { selector: "#submit" } }),
    });
    expect(badAction.status).toBe(400);
    expect(JSON.parse(badAction.body).error.message).toContain("action.type");

    const badSize = await request(server.port, {
      method: "POST",
      path: "/v1/sessions",
      headers: leaseHeaders(),
      body: JSON.stringify({ width: 12 }),
    });
    expect(badSize.status).toBe(400);
  });

  it("creates profile-backed sessions and exposes profile management", async () => {
    const harness = await startLeaseHarness();
    const created = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions",
      headers: leaseHeaders(),
      body: JSON.stringify({ profile: "work" }),
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body).profile).toBe("work");
    expect(vi.mocked(harness.manager.create).mock.calls[0][0]).toMatchObject({ profile: "work" });

    const badProfile = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions",
      headers: leaseHeaders(),
      body: JSON.stringify({ profile: 42 }),
    });
    expect(badProfile.status).toBe(400);
    expect(JSON.parse(badProfile.body).error.code).toBe("E_BAD_REQUEST");

    const list = await request(harness.server.port, { path: "/v1/profiles", headers: leaseHeaders() });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).profiles[0].name).toBe("work");

    const cleared = await request(harness.server.port, {
      method: "DELETE",
      path: "/v1/profiles/work",
      headers: leaseHeaders(),
    });
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body).profile).toBe("work");

    const tool = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/profiles",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ action: "list" }),
    });
    expect(tool.status).toBe(200);
    expect(JSON.parse(tool.body).result.profiles).toHaveLength(1);
  });

  it("refuses to clear a profile that still has live sessions", async () => {
    const harness = await startLeaseHarness();
    vi.mocked(harness.manager.clearProfile).mockRejectedValueOnce(
      new DemoError("E_PROFILE_LOCKED", "profile work 仍有 1 个 session 在使用"),
    );
    const locked = await request(harness.server.port, {
      method: "DELETE",
      path: "/v1/profiles/work",
      headers: leaseHeaders(),
    });
    expect(locked.status).toBe(409);
    expect(JSON.parse(locked.body).error.code).toBe("E_PROFILE_LOCKED");
  });

  it("imports login state into a profile from a loopback CDP source", async () => {
    const harness = await startLeaseHarness();
    const ok = await request(harness.server.port, {
      method: "POST",
      path: "/v1/profiles/work/import",
      headers: leaseHeaders(),
      body: JSON.stringify({ cdp_url: "http://127.0.0.1:9223", domains: ["example.com"] }),
    });
    expect(ok.status).toBe(200);
    const parsed = JSON.parse(ok.body);
    expect(parsed.profile).toBe("work");
    expect(parsed.cookies_written).toBe(4);
    expect(vi.mocked(harness.manager.importProfileLogin).mock.calls[0][1]).toMatchObject({
      cdp_url: "http://127.0.0.1:9223",
      domains: ["example.com"],
      session_cookie_ttl_days: 180,
    });

    const missingUrl = await request(harness.server.port, {
      method: "POST",
      path: "/v1/profiles/work/import",
      headers: leaseHeaders(),
      body: JSON.stringify({}),
    });
    expect(missingUrl.status).toBe(400);

    const badTtl = await request(harness.server.port, {
      method: "POST",
      path: "/v1/profiles/work/import",
      headers: leaseHeaders(),
      body: JSON.stringify({ cdp_url: "http://127.0.0.1:9223", session_cookie_ttl_days: -1 }),
    });
    expect(badTtl.status).toBe(400);

    vi.mocked(harness.manager.importProfileLogin).mockRejectedValueOnce(
      new DemoError("E_IMPORT_SOURCE_UNREACHABLE", "连不上源 CDP"),
    );
    const failing = await request(harness.server.port, {
      method: "POST",
      path: "/v1/profiles/work/import",
      headers: leaseHeaders(),
      body: JSON.stringify({ cdp_url: "http://127.0.0.1:9223" }),
    });
    expect(failing.status).toBe(502);
    expect(JSON.parse(failing.body).error.code).toBe("E_IMPORT_SOURCE_UNREACHABLE");
  });

  it("returns navigation diagnostics and rejects an invalid settle window", async () => {
    const harness = await startLeaseHarness();
    harness.sessions.get("session-a")!.navigate.mockRejectedValueOnce(
      new DemoError("E_NAV_FAILED", "net::ERR_CONNECTION_TIMED_OUT", {
        details: {
          navigation: { net_error: -118, load_state: "failed", final_url: "chrome-error://chromewebdata/" },
        },
      }),
    );
    const failed = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/navigate",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ url: "https://example.com", settle_ms: 2000 }),
    });
    expect(failed.status).toBe(502);
    const body = JSON.parse(failed.body);
    expect(body.error.code).toBe("E_NAV_FAILED");
    expect(body.error.details.navigation.net_error).toBe(-118);

    const badSettle = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/navigate",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ url: "https://example.com", settle_ms: 20_000 }),
    });
    expect(badSettle.status).toBe(400);
    expect(JSON.parse(badSettle.body).error.message).toContain("settle_ms");
  });

  it("publishes agent tools and invokes them with session tokens", async () => {
    const harness = await startLeaseHarness();
    const tools = await request(harness.server.port, {
      path: "/v1/tools",
      headers: leaseHeaders(),
    });
    expect(tools.status).toBe(200);
    const names = JSON.parse(tools.body).tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "navigate",
        "observe",
        "snapshot",
        "extract",
        "click",
        "fill",
        "history",
        "network_capture",
        "responses",
        "close",
      ]),
    );

    const published = JSON.parse(tools.body).tools as Array<{
      name: string;
      input_schema: {
        additionalProperties: boolean;
        properties: Record<string, { type: string; items?: { type: string } }>;
      };
    }>;
    const captureSchema = published.find((tool) => tool.name === "network_capture")!;
    expect(captureSchema.input_schema.properties.url_prefixes.type).toBe("array");
    expect(captureSchema.input_schema.properties.url_prefixes.items?.type).toBe("string");
    expect(captureSchema.input_schema.additionalProperties).toBe(false);
    const responsesSchema = published.find((tool) => tool.name === "responses")!;
    expect(responsesSchema.input_schema.properties.limit.type).toBe("integer");
    expect(responsesSchema.input_schema.additionalProperties).toBe(false);

    const subscribed = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/network_capture",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ url_prefixes: ["http://127.0.0.1:4788/api/"] }),
    });
    expect(subscribed.status).toBe(200);
    expect(JSON.parse(subscribed.body).result.url_prefixes).toEqual([
      "http://127.0.0.1:4788/api/",
    ]);
    expect(harness.sessions.get("session-a")!.networkCapture).toHaveBeenCalledWith({
      url_prefixes: ["http://127.0.0.1:4788/api/"],
    });

    const responses = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/responses",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ after: 0, limit: 20 }),
    });
    expect(responses.status).toBe(200);
    expect(JSON.parse(responses.body).result).toEqual({ responses: [], has_more: false });

    const snapshot = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/snapshot",
      headers: sessionHeaders(SESSION_A),
      body: "{}",
    });
    expect(snapshot.status).toBe(200);
    expect(JSON.parse(snapshot.body)).toMatchObject({
      tool: "snapshot",
      result: { text: "hello" },
    });
    expect(harness.sessions.get("session-a")!.snapshot).toHaveBeenCalledOnce();

    const click = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/click",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ selector: "#submit" }),
    });
    expect(click.status).toBe(200);
    expect(harness.sessions.get("session-a")!.act).toHaveBeenCalledWith({
      selector: "#submit",
      type: "click",
    });

    const login = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/login",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ mode: "password", username: "demo", password: "super-secret" }),
    });
    expect(login.status).toBe(200);
    expect(login.body).not.toContain("super-secret");
    expect(harness.sessions.get("session-a")!.login).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "password", password: "super-secret" }),
    );

    const watch = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/watch",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ focus: false }),
    });
    expect(watch.status).toBe(200);
    expect(JSON.parse(watch.body).result.window).toBe("shown");

    const directWatch = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/watch",
      headers: sessionHeaders(SESSION_A),
      body: JSON.stringify({ focus: false }),
    });
    expect(directWatch.status).toBe(200);

    const missingUrl = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/navigate",
      headers: sessionHeaders(SESSION_A),
      body: "{}",
    });
    expect(missingUrl.status).toBe(400);
    expect(JSON.parse(missingUrl.body).error.code).toBe("E_BAD_REQUEST");

    const unknown = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/teleport",
      headers: sessionHeaders(SESSION_A),
      body: "{}",
    });
    expect(unknown.status).toBe(400);
    expect(JSON.parse(unknown.body).error.code).toBe("E_UNSUPPORTED");
  });

  it("surfaces a capture subsystem failure as ok:false, not an empty list", async () => {
    const harness = await startLeaseHarness();
    harness.sessions.get("session-a")!.responses.mockRejectedValueOnce(
      new DemoError(
        "E_CAPTURE_UNAVAILABLE",
        "网络捕获不可用：Network.enable 失败：quota exceeded",
      ),
    );

    const failed = await request(harness.server.port, {
      method: "POST",
      path: "/v1/sessions/session-a/tools/responses",
      headers: sessionHeaders(SESSION_A),
      body: "{}",
    });

    expect(failed.status).toBe(500);
    const body = JSON.parse(failed.body);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("E_CAPTURE_UNAVAILABLE");
    expect(body.error.message).toContain("quota exceeded");
    expect(body.tool).toBeUndefined();
    expect(body.result).toBeUndefined();
  });

  it("answers assert verdicts with 200: pass, fail, and bad arguments", async () => {
    const harness = await startLeaseHarness();
    const session = harness.sessions.get("session-a")!;
    const assertUrl = "/v1/sessions/session-a/tools/assert";
    const assertCall = (body: Record<string, unknown>) =>
      request(harness.server.port, {
        method: "POST",
        path: assertUrl,
        headers: sessionHeaders(SESSION_A),
        body: JSON.stringify(body),
      });

    const passed = await assertCall({ visible: "#done" });
    expect(passed.status).toBe(200);
    const passedBody = JSON.parse(passed.body);
    expect(passedBody.tool).toBe("assert");
    expect(passedBody.result).toMatchObject({ ok: true, passed: true });
    expect(passedBody.result.checks[0]).toEqual({
      kind: "visible",
      expected: true,
      actual: true,
      ok: true,
    });

    session.assertExpectations.mockRejectedValueOnce(
      new DemoError("E_ASSERTION_FAILED", "断言失败：visible expected true, got false", {
        url: "http://127.0.0.1/dashboard",
        selector: "#done",
        screenshotPath: "/tmp/artifacts/failure-1.png",
        details: {
          checks: [{ kind: "visible", expected: true, actual: false, ok: false }],
          waited_ms: 5001,
        },
      }),
    );
    const failed = await assertCall({ visible: "#done" });
    expect(failed.status).toBe(200);
    const failedBody = JSON.parse(failed.body);
    expect(failedBody.tool).toBe("assert");
    expect(failedBody.result).toMatchObject({
      ok: false,
      passed: false,
      url: "http://127.0.0.1/dashboard",
      waited_ms: 5001,
      screenshot: "/tmp/artifacts/failure-1.png",
    });
    expect(failedBody.result.error.code).toBe("E_ASSERTION_FAILED");
    expect(failedBody.result.error.details.checks).toEqual([
      { kind: "visible", expected: true, actual: false, ok: false },
    ]);
    expect(failedBody.result.error.details.screenshotPath).toBe("/tmp/artifacts/failure-1.png");

    const noConditions = await assertCall({});
    expect(noConditions.status).toBe(400);
    expect(JSON.parse(noConditions.body).error.code).toBe("E_BAD_REQUEST");

    const missingSelector = await assertCall({ value: "x" });
    expect(missingSelector.status).toBe(400);
    expect(JSON.parse(missingSelector.body).error.code).toBe("E_BAD_REQUEST");
  });

  it("accepts legacy token headers during the malo-browser rename", async () => {
    const { server } = await startLeaseHarness();
    const tools = await request(server.port, {
      path: "/v1/tools",
      headers: { "x-pagehand-lease-token": LEASE_TOKEN },
    });
    expect(tools.status).toBe(200);

    const scoped = await request(server.port, {
      path: "/v1/sessions/session-a",
      headers: {
        "x-pagehand-lease-token": LEASE_TOKEN,
        "x-pagehand-session-token": SESSION_A,
      },
    });
    expect(scoped.status).toBe(200);
  });

  it("maps a session cap to 429 and an unknown session to 404", async () => {
    const sessions = new Map<string, FakeSession>();
    const manager = {
      create: vi.fn(async () => {
        throw new DemoError("E_RESOURCE_LIMIT", "已达到 session 上限");
      }),
      list: vi.fn(() => []),
      get: vi.fn((id: string) => {
        throw new DemoError("E_SESSION_NOT_FOUND", `session 不存在：${id}`);
      }),
      close: vi.fn(),
      closeAll: vi.fn(),
      reapIdle: vi.fn(async () => []),
    } as unknown as SessionManager;
    const server = await startLeaseServer({
      port: 0,
      token: LEASE_TOKEN,
      leaseId: "lease-test",
      agentId: "agent-a",
      manager,
      sessionIdleMs: 60_000,
    });
    servers.push(server);

    const capped = await request(server.port, {
      method: "POST",
      path: "/v1/sessions",
      headers: leaseHeaders(),
      body: "{}",
    });
    expect(capped.status).toBe(429);
    expect(JSON.parse(capped.body).error.code).toBe("E_RESOURCE_LIMIT");

    const missingToken = await request(server.port, {
      path: "/v1/sessions/missing",
      headers: sessionHeaders(SESSION_A),
    });
    expect(missingToken.status).toBe(404);
    expect(JSON.parse(missingToken.body).error.code).toBe("E_SESSION_NOT_FOUND");
    expect(sessions.size).toBe(0);
  });
});
