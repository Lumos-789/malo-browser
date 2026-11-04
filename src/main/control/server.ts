import crypto from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { DirectorSnapshot } from "../../preload/director-api";
import { isDemoError } from "../../shared/errors";
import type { AppEvent, ControlCommand } from "../../shared/types";
import { explainListenFailure } from "../tools";

const LOOPBACK = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;

export const SUPPORTED_ROUTES = [
  "GET /health",
  "GET /state",
  "GET /scenes",
  "GET /events",
  "POST /command",
] as const;

export type ControlApiOptions = {
  send(command: ControlCommand): Promise<unknown>;
  getSnapshot(): DirectorSnapshot;
  onEvent(listener: (event: AppEvent) => void): () => void;
  port?: number;
  token?: string;
  recordFile?: string;
  heartbeatMs?: number;
};

export type ControlServer = {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
};

type ErrorPayload = { ok: false; error: { code: string; message: string } };

class BodyTooLarge extends Error {}
class BadRequestBody extends Error {}

function errorPayload(code: string, message: string): ErrorPayload {
  return { ok: false, error: { code, message } };
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, status, errorPayload(code, message), extraHeaders);
}

export function constantTimeTokenMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const custom = req.headers["x-demo-token"];
  if (typeof custom === "string" && custom.trim() !== "") return custom.trim();
  return null;
}

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const [mediaType] = value.split(";");
  return mediaType.trim().toLowerCase() === "application/json";
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new BodyTooLarge(`请求体超过 ${limit} 字节`));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settle(() => reject(new BodyTooLarge(`请求体超过 ${limit} 字节`)));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle(() => resolve(Buffer.concat(chunks))));
    req.on("aborted", () => settle(() => reject(new BadRequestBody("请求被中断"))));
    req.on("error", (error) => settle(() => reject(error)));
  });
}

function commandErrorStatus(code: string): number {
  switch (code) {
    case "E_PROFILE_LOCKED":
    case "E_STEP_TIMEOUT":
    case "E_RECORDER_NO_FRAMES":
      return 409;
    default:
      return 400;
  }
}

function parseCommand(raw: Buffer): ControlCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BadRequestBody("请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestBody("命令必须是 {cmd, args} 对象");
  }
  const candidate = parsed as { cmd?: unknown; args?: unknown };
  if (typeof candidate.cmd !== "string" || candidate.cmd.trim() === "") {
    throw new BadRequestBody("命令缺少 cmd 字段");
  }
  const args = candidate.args ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new BadRequestBody("args 必须是对象");
  }
  return { cmd: candidate.cmd, args } as ControlCommand;
}

export async function startControlServer(options: ControlApiOptions): Promise<ControlServer> {
  const token = options.token ?? crypto.randomBytes(32).toString("hex");
  if (token === "") {
    throw new Error("控制 API token 不能为空");
  }
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new Error(`控制 API 心跳间隔必须是正毫秒数：${options.heartbeatMs}`);
  }

  const streams = new Map<ServerResponse, () => void>();
  let closed = false;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, "E_CONTROL_INTERNAL", message);
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { port } = server.address() as { port: number };

    if (!isAllowedHost(req.headers.host, port)) {
      sendError(res, 403, "E_CONTROL_FORBIDDEN", `拒绝的 Host 头：${req.headers.host ?? "(缺失)"}`);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${LOOPBACK}:${port}`);
    const route = `${req.method ?? "GET"} ${url.pathname}`;

    if (route === "GET /health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    const provided = extractToken(req);
    if (provided === null || !constantTimeTokenMatch(token, provided)) {
      sendError(res, 401, "E_CONTROL_UNAUTHORIZED", "缺少或错误的控制 token");
      return;
    }

    if (route === "GET /state") {
      sendJson(res, 200, options.getSnapshot());
      return;
    }

    if (route === "GET /scenes") {
      sendJson(res, 200, { scenes: options.getSnapshot().scenes ?? [] });
      return;
    }

    if (route === "GET /events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write("retry: 1000\n\n");
      res.write(": connected\n\n");

      const unsubscribeStream = options.onEvent((event) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        res.write(": ping\n\n");
      }, heartbeatMs);
      heartbeat.unref();
      streams.set(res, unsubscribeStream);

      const drop = () => {
        if (!streams.has(res)) return;
        streams.delete(res);
        clearInterval(heartbeat);
        unsubscribeStream();
      };
      req.on("close", drop);
      res.on("close", drop);
      req.socket.once("close", drop);
      return;
    }

    if (route === "POST /command") {
      if (!isJsonContentType(req.headers["content-type"])) {
        sendError(res, 415, "E_CONTROL_UNSUPPORTED_MEDIA_TYPE", "content-type 必须是 application/json");
        return;
      }

      let raw: Buffer;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          sendError(res, 413, "E_CONTROL_PAYLOAD_TOO_LARGE", error.message, { connection: "close" });
          req.resume();
          return;
        }
        throw error;
      }

      let command: ControlCommand;
      try {
        command = parseCommand(raw);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendError(res, 400, "E_CONTROL_BAD_REQUEST", message);
        return;
      }

      try {
        const result = await options.send(command);
        sendJson(res, 200, { ok: true, result: result ?? null });
      } catch (error) {
        if (isDemoError(error)) {
          sendError(res, commandErrorStatus(error.code), error.code, error.message);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        sendError(res, 500, "E_CONTROL_INTERNAL", message);
      }
      return;
    }

    sendError(res, 404, "E_CONTROL_NOT_FOUND", `未知路由 ${route}，可用路由：${SUPPORTED_ROUTES.join("、")}`);
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(explainListenFailure(options.port ?? 0, error, "control"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port ?? 0, LOOPBACK);
  });

  const port = (server.address() as { port: number }).port;
  const url = `http://${LOOPBACK}:${port}`;

  if (options.recordFile) {
    const target = path.resolve(options.recordFile);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify({ url, token, pid: process.pid }, null, 2)}\n`, { mode: 0o600 });
    await chmod(target, 0o600);
  }

  return {
    url,
    token,
    port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const [res, unsubscribeStream] of streams) {
        unsubscribeStream();
        res.end();
      }
      streams.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
    },
  };
}
