import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isDemoError } from "../../shared/errors";
import type { MaloLease } from "../../shared/malo";
import { MALO_LEASE_REQUEST } from "../../shared/malo-tools";
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
import type { LeaseRecord } from "./lease-manager";

export type BrokerServerOptions = {
  port: number;
  token: string;
  /** 握手信息：写进 /health 与租约响应，客户端据此判断能力。 */
  version: string;
  features: string[];
  leaseTtlSeconds: number;
  createLease(agentId: string, holderId: string | null): Promise<MaloLease>;
  heartbeat(id: string): LeaseRecord;
  release(id: string): Promise<void>;
  list(): MaloLease[];
  state(): Record<string, unknown>;
};

export type BrokerServer = {
  url: string;
  port: number;
  close(): Promise<void>;
};

export function publicLease(
  lease: LeaseRecord,
  handshake: Pick<BrokerServerOptions, "version" | "features" | "leaseTtlSeconds">,
): MaloLease {
  return {
    lease_id: lease.id,
    agent_id: lease.agentId,
    endpoint: `http://${LOOPBACK}:${lease.port}`,
    token: lease.token,
    expires_at: new Date(lease.expiresAtMs).toISOString(),
    version: handshake.version,
    features: handshake.features,
    ttl_seconds: handshake.leaseTtlSeconds,
  };
}

// holder = 持有者标识（客户端进程级唯一）。带了它的请求只和「同 agent 名 + 同 holder」
// 的租约复用；不带 = 旧客户端，沿用只按 agent 名复用。
function readHolder(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim().length > MALO_LEASE_REQUEST.holder.maxLength) {
    throw new BadRequest("holder 必须是 1-128 字符的非空字符串（持有者标识）");
  }
  return raw.trim();
}

function statusFor(error: unknown): number {
  if (error instanceof BodyTooLarge) return 413;
  if (error instanceof BadRequest) return 400;
  if (isDemoError(error)) {
    if (error.code === "E_RESOURCE_LIMIT") return 429;
    if (error.code === "E_LEASE_NOT_FOUND" || error.code === "E_LEASE_EXPIRED") return 404;
  }
  return 500;
}

function codeFor(error: unknown): string {
  if (error instanceof BadRequest) return "E_BAD_REQUEST";
  if (error instanceof BodyTooLarge) return "E_RESOURCE_LIMIT";
  if (isDemoError(error)) return error.code;
  return "E_BROKER_INTERNAL";
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!isDemoError(error)) return undefined;
  const { code: _code, message: _message, details, ...rest } = error.toDetail();
  return { ...rest, ...(details ?? {}) };
}

export async function startBrokerServer(options: BrokerServerOptions): Promise<BrokerServer> {
  if (options.token.trim() === "") throw new Error("broker token 不能为空");
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
      sendJson(res, 200, {
        status: "ok",
        service: "malo-broker",
        version: options.version,
        features: options.features,
      });
      return;
    }
    const provided = extractBearer(req, "x-malo-broker-token");
    if (!provided || !tokenMatches(options.token, provided)) {
      sendError(res, 401, "E_CONTROL_UNAUTHORIZED", "缺少或错误的 broker token");
      return;
    }
    if (route === "GET /v1/state") {
      sendJson(res, 200, options.state());
      return;
    }
    if (route === "GET /v1/leases") {
      sendJson(res, 200, { leases: options.list() });
      return;
    }
    if (route === "POST /v1/leases") {
      const body = await readJsonObject(req);
      const agentId = typeof body.agent_id === "string" ? body.agent_id : "";
      if (agentId.trim() === "") throw new BadRequest("agent_id 必须是非空字符串");
      sendJson(res, 201, await options.createLease(agentId, readHolder(body.holder)));
      return;
    }
    const match = /^\/v1\/leases\/([^/]+)\/heartbeat$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      sendJson(res, 200, publicLease(options.heartbeat(decodeURIComponent(match[1])), options));
      return;
    }
    const deleteMatch = /^\/v1\/leases\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && deleteMatch) {
      await options.release(decodeURIComponent(deleteMatch[1]));
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 404, "E_CONTROL_NOT_FOUND", `未知路由 ${route}`);
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(explainListenFailure(options.port, error, "broker"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, LOOPBACK);
  });

  const port = (server.address() as { port: number }).port;
  return {
    url: `http://${LOOPBACK}:${port}`,
    port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
