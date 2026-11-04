import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const LOOPBACK = "127.0.0.1";
export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLarge extends Error {}
export class BadRequest extends Error {}

export function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function extractBearer(req: IncomingMessage, header = "x-malo-token"): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }
  const legacyHeader = header.startsWith("x-malo-")
    ? header.replace("x-malo-", "x-pagehand-")
    : null;
  const custom = req.headers[header] ?? (legacyHeader ? req.headers[legacyHeader] : undefined);
  if (typeof custom === "string" && custom.trim() !== "") return custom.trim();
  return null;
}

export function allowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  return value === `127.0.0.1:${port}` || value === `localhost:${port}`;
}

export function sendJson(
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

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, {
    ok: false,
    error: { code, message, ...(details && Object.keys(details).length > 0 ? { details } : {}) },
  });
}

export function isJson(req: IncomingMessage): boolean {
  const value = req.headers["content-type"];
  if (typeof value !== "string") return false;
  const [mediaType] = value.split(";");
  return mediaType.trim().toLowerCase() === "application/json";
}

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
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
    req.on("aborted", () => settle(() => reject(new BadRequest("请求被中断"))));
    req.on("error", (error) => settle(() => reject(error)));
  });
}

export async function readJsonObject(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!isJson(req)) throw new BadRequest("content-type 必须是 application/json");
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BadRequest("请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BadRequest("请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}
