import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isDemoError } from "../../shared/errors";
import type { MaloAction, MaloLoginInput } from "../../shared/malo";
import { MALO_TOOLS } from "../../shared/malo-tools";
import { explainListenFailure } from "../tools";
import {
  BadRequest,
  BodyTooLarge,
  LOOPBACK,
  allowedHost,
  extractBearer,
  readJsonObject,
  sendError,
  sendJson,
  tokenMatches,
} from "./http";
import type { SessionManager } from "./session-manager";
import { assertFailureResult, invokeMaloTool } from "./tools";

export type LeaseServerOptions = {
  port: number;
  token: string;
  leaseId: string;
  agentId: string;
  manager: SessionManager;
  sessionIdleMs: number;
};

export type LeaseServer = {
  port: number;
  url: string;
  close(): Promise<void>;
};

function statusFor(error: unknown): number {
  if (error instanceof BodyTooLarge) return 413;
  if (error instanceof BadRequest) return 400;
  if (isDemoError(error)) {
    if (error.code === "E_SESSION_NOT_FOUND") return 404;
    if (error.code === "E_PROFILE_LOCKED") return 409;
    if (error.code === "E_RESOURCE_LIMIT") return 429;
    if (error.code === "E_IMPORT_SOURCE_UNREACHABLE") return 502;
    if (error.code === "E_IMPORT_EMPTY") return 400;
    if (
      error.code === "E_NAV_BLOCKED" ||
      error.code === "E_UNSUPPORTED" ||
      error.code === "E_SELECTOR_NOT_FOUND" ||
      error.code === "E_BAD_REQUEST"
    ) {
      return 400;
    }
    if (error.code === "E_NAV_FAILED") return 502;
    if (error.code === "E_STEP_TIMEOUT") return 504;
  }
  return 500;
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!isDemoError(error)) return undefined;
  const { code: _code, message: _message, details, ...rest } = error.toDetail();
  return { ...rest, ...(details ?? {}) };
}

function codeFor(error: unknown): string {
  if (error instanceof BadRequest) return "E_BAD_REQUEST";
  if (error instanceof BodyTooLarge) return "E_RESOURCE_LIMIT";
  if (isDemoError(error)) return error.code;
  return "E_LEASE_INTERNAL";
}

function sessionToken(req: IncomingMessage): string | null {
  const value =
    req.headers["x-malo-session-token"] ?? req.headers["x-pagehand-session-token"];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function startLeaseServer(options: LeaseServerOptions): Promise<LeaseServer> {
  if (options.token.trim() === "") throw new Error("lease token 不能为空");
  let closed = false;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, statusFor(error), codeFor(error), message, errorDetails(error));
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { port } = server.address() as { port: number };
    if (!allowedHost(req.headers.host, port)) {
      sendError(res, 403, "E_CONTROL_FORBIDDEN", `拒绝的 Host 头：${req.headers.host ?? "(缺失)"}`);
      return;
    }
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}:${port}`);
    const route = `${req.method ?? "GET"} ${url.pathname}`;
    if (route === "GET /health") {
      sendJson(res, 200, { status: "ok", service: "malo-lease" });
      return;
    }
    const provided = extractBearer(req, "x-malo-lease-token");
    if (!provided || !tokenMatches(options.token, provided)) {
      sendError(res, 401, "E_CONTROL_UNAUTHORIZED", "缺少或错误的 lease token");
      return;
    }
    if (route === "GET /v1/state") {
      sendJson(res, 200, {
        lease_id: options.leaseId,
        agent_id: options.agentId,
        sessions: options.manager.list(),
      });
      return;
    }
    if (route === "GET /v1/tools") {
      sendJson(res, 200, { tools: MALO_TOOLS });
      return;
    }
    if (route === "GET /v1/sessions") {
      sendJson(res, 200, { sessions: options.manager.list() });
      return;
    }
    if (route === "GET /v1/profiles") {
      sendJson(res, 200, { profiles: await options.manager.listProfiles() });
      return;
    }
    if (route === "POST /v1/sessions") {
      const body = await readJsonObject(req);
      const width = readOptionalDimension(body.width, "width");
      const height = readOptionalDimension(body.height, "height");
      if (body.profile !== undefined && typeof body.profile !== "string") {
        throw new BadRequest("profile 必须是字符串");
      }
      const session = await options.manager.create({
        name: typeof body.name === "string" ? body.name : undefined,
        profile: body.profile,
        width,
        height,
      });
      sendJson(res, 201, session);
      return;
    }
    const profileMatch = /^\/v1\/profiles\/([^/]+)$/.exec(url.pathname);
    if (profileMatch && req.method === "DELETE") {
      const name = decodeURIComponent(profileMatch[1]);
      sendJson(res, 200, await options.manager.clearProfile(name));
      return;
    }
    const importMatch = /^\/v1\/profiles\/([^/]+)\/import$/.exec(url.pathname);
    if (importMatch && req.method === "POST") {
      const body = await readJsonObject(req);
      if (typeof body.cdp_url !== "string" || body.cdp_url.trim() === "") {
        throw new BadRequest("cdp_url 必须是非空字符串（源 Chrome 的 CDP 端点，如 http://127.0.0.1:9223）");
      }
      const domains =
        Array.isArray(body.domains) && body.domains.length > 0
          ? body.domains.filter((domain): domain is string => typeof domain === "string" && domain !== "")
          : undefined;
      if (body.domains !== undefined && domains === undefined) {
        throw new BadRequest("domains 必须是非空字符串数组");
      }
      const ttlDays =
        body.session_cookie_ttl_days === undefined ? 180 : Number(body.session_cookie_ttl_days);
      if (!Number.isFinite(ttlDays) || ttlDays < 0 || ttlDays > 3650) {
        throw new BadRequest("session_cookie_ttl_days 必须是 0-3650 的数字");
      }
      sendJson(
        res,
        200,
        await options.manager.importProfileLogin(decodeURIComponent(importMatch[1]), {
          cdp_url: body.cdp_url,
          domains,
          session_cookie_ttl_days: ttlDays,
        }),
      );
      return;
    }
    const authorizedSession = (id: string) => {
      const session = options.manager.get(id);
      const suppliedSessionToken = sessionToken(req);
      if (!suppliedSessionToken || !tokenMatches(session.token, suppliedSessionToken)) {
        sendError(res, 401, "E_CONTROL_UNAUTHORIZED", "缺少或错误的 session token");
        return null;
      }
      return session;
    };

    const toolMatch = /^\/v1\/sessions\/([^/]+)\/tools\/([^/]+)$/.exec(url.pathname);
    if (toolMatch && req.method === "POST") {
      const id = decodeURIComponent(toolMatch[1]);
      const session = authorizedSession(id);
      if (!session) return;
      const tool = decodeURIComponent(toolMatch[2]);
      const body = await readJsonObject(req);
      if (tool === "close") {
        await options.manager.close(id);
        sendJson(res, 200, { tool: "close", result: { closed: true } });
        return;
      }
      if (tool === "profiles") {
        const action = body.action ?? "list";
        if (action === "list") {
          sendJson(res, 200, { tool, result: { profiles: await options.manager.listProfiles() } });
          return;
        }
        if (action === "clear") {
          if (typeof body.name !== "string") throw new BadRequest("clear 需要 name");
          sendJson(res, 200, { tool, result: await options.manager.clearProfile(body.name) });
          return;
        }
        throw new BadRequest("profiles.action 只能是 list 或 clear");
      }
      try {
        sendJson(res, 200, await invokeMaloTool(tool, body, session));
      } catch (error) {
        // A failed assertion is a business verdict: same shape as a failed
        // run_steps report (200 + ok:false) instead of an HTTP error status.
        const verdict = tool === "assert" ? assertFailureResult(error) : null;
        if (!verdict) throw error;
        sendJson(res, 200, { tool, result: verdict });
      }
      return;
    }

    const match = /^\/v1\/sessions\/([^/]+)(?:\/(navigate|observe|actions|events|login|watch))?$/.exec(
      url.pathname,
    );
    if (match) {
      const id = decodeURIComponent(match[1]);
      const session = authorizedSession(id);
      if (!session) return;
      const op = match[2];
      if (!op && req.method === "GET") {
        sendJson(res, 200, session.summary());
        return;
      }
      if (!op && req.method === "DELETE") {
        await options.manager.close(id);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (op === "navigate" && req.method === "POST") {
        const body = await readJsonObject(req);
        if (typeof body.url !== "string") throw new BadRequest("url 必须是字符串");
        const timeoutMs = readOptionalTimeout(body.timeout_ms, 30_000);
        const settleMs = readOptionalSettle(body.settle_ms, 6_000);
        sendJson(res, 200, await session.navigate(body.url, timeoutMs, settleMs));
        return;
      }
      if (op === "observe" && req.method === "GET") {
        const mode = url.searchParams.get("mode") ?? "light";
        if (mode !== "light" && mode !== "screenshot") {
          throw new BadRequest("mode 只能是 light 或 screenshot");
        }
        const maxChars = readQueryInteger(url.searchParams.get("max_chars"), "max_chars", 2_000, 0, 20_000);
        sendJson(res, 200, await session.observe(mode, maxChars));
        return;
      }
      if (op === "actions" && req.method === "POST") {
        const body = await readJsonObject(req);
        const action = body.action;
        if (typeof action !== "object" || action === null || Array.isArray(action)) {
          throw new BadRequest("action 必须是对象");
        }
        const typed = action as Record<string, unknown>;
        if (typeof typed.type !== "string" || typed.type === "") {
          throw new BadRequest("action.type 必须是非空字符串");
        }
        sendJson(res, 200, await session.act(action as MaloAction));
        return;
      }
      if (op === "events" && req.method === "GET") {
        const after = readQueryInteger(url.searchParams.get("after"), "after", 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = readQueryInteger(url.searchParams.get("limit"), "limit", 100, 1, 200);
        sendJson(res, 200, { events: session.eventsAfter(after, limit) });
        return;
      }
      if (op === "login" && req.method === "POST") {
        const body = await readJsonObject(req);
        sendJson(res, 200, await session.login(body as MaloLoginInput));
        return;
      }
      if (op === "watch" && req.method === "POST") {
        const body = await readJsonObject(req);
        if (body.show !== undefined && typeof body.show !== "boolean") {
          throw new BadRequest("show 必须是布尔值");
        }
        if (body.focus !== undefined && typeof body.focus !== "boolean") {
          throw new BadRequest("focus 必须是布尔值");
        }
        sendJson(
          res,
          200,
          await session.watch({
            show: body.show as boolean | undefined,
            focus: body.focus as boolean | undefined,
            width: readOptionalDimension(body.width, "width"),
            height: readOptionalDimension(body.height, "height"),
          }),
        );
        return;
      }
    }
    sendError(res, 404, "E_CONTROL_NOT_FOUND", `未知路由 ${route}`);
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(explainListenFailure(options.port, error, "lease"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, LOOPBACK);
  });

  const reaper = setInterval(() => {
    void options.manager.reapIdle(options.sessionIdleMs).catch((error: unknown) => {
      console.error(`[malo] 回收空闲 session 失败：${(error as Error).message}`);
    });
  }, Math.max(1_000, Math.min(30_000, Math.floor(options.sessionIdleMs / 2))));
  reaper.unref();

  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://${LOOPBACK}:${port}`,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(reaper);
      await options.manager.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function readOptionalDimension(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 64 || number > 3840) {
    throw new BadRequest(`${field} 必须是 64-3840 的整数`);
  }
  return number;
}

function readOptionalTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 100 || number > 120_000) {
    throw new BadRequest("timeout_ms 必须是 100-120000 的整数");
  }
  return number;
}

function readOptionalSettle(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 15_000) {
    throw new BadRequest("settle_ms 必须是 0-15000 的整数");
  }
  return number;
}

function readQueryInteger(
  raw: string | null,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null || raw === "") return fallback;
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new BadRequest(`${field} 必须是 ${min}-${max} 的整数`);
  }
  return number;
}
