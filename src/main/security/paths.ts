import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DemoError } from "../../shared/errors";

export const ALLOWED_SCENE_EXTENSIONS = [
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".webp",
  ".woff2",
  ".json",
  ".txt",
  ".md",
] as const;

const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(ALLOWED_SCENE_EXTENSIONS);
const MAX_DECODE_ROUNDS = 3;

function blocked(message: string, url: string): DemoError {
  return new DemoError("E_NAV_BLOCKED", message, { url });
}

function isAbsoluteRequest(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

function assertSafeRelative(value: string, raw: string): void {
  if (value.includes("\0")) throw blocked("request path contains a NUL byte", raw);
  if (isAbsoluteRequest(value)) throw blocked("request path must be relative", raw);
  if (hasParentSegment(value)) throw blocked("request path contains parent traversal", raw);
}

function decodeRequestPath(raw: string): string {
  let current = raw;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    assertSafeRelative(current, raw);
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      throw blocked("request path has malformed percent-encoding", raw);
    }
    if (decoded === current) return current;
    current = decoded;
  }
  assertSafeRelative(current, raw);
  return current;
}

function assertAllowedExtension(target: string, raw: string): void {
  const extension = path.extname(target).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw blocked(`extension not allowed: ${extension || "(none)"}`, raw);
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function fsCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export async function resolveScenePath(sceneRoot: string, requestPath: string): Promise<string> {
  if (typeof sceneRoot !== "string" || !path.isAbsolute(sceneRoot)) {
    throw new DemoError("E_SCENE_INVALID", `scene root must be an absolute path: ${String(sceneRoot)}`);
  }
  if (typeof requestPath !== "string" || requestPath.trim() === "") {
    throw new DemoError("E_SCENE_INVALID", "request path must be a non-empty string");
  }

  let rootReal: string;
  try {
    rootReal = await realpath(sceneRoot);
  } catch (error) {
    throw new DemoError("E_SCENE_NOT_FOUND", `scene root does not exist: ${sceneRoot}`, {
      details: { cause: fsCode(error) },
    });
  }
  const rootStat = await stat(rootReal);
  if (!rootStat.isDirectory()) {
    throw new DemoError("E_SCENE_INVALID", `scene root is not a directory: ${sceneRoot}`);
  }

  const decoded = decodeRequestPath(requestPath);
  const segments = decoded.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) throw blocked("request path does not name a file", requestPath);

  const relative = segments.join(path.sep);
  assertAllowedExtension(relative, requestPath);

  const candidate = path.join(rootReal, relative);
  if (!isInside(rootReal, candidate)) throw blocked("request path escapes the scene root", requestPath);

  let targetReal: string;
  try {
    targetReal = await realpath(candidate);
  } catch (error) {
    const code = fsCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DemoError("E_SCENE_NOT_FOUND", `scene file does not exist: ${relative}`, { url: requestPath });
    }
    throw new DemoError("E_SCENE_INVALID", `cannot resolve scene file: ${relative} (${code ?? "unknown"})`, {
      url: requestPath,
      details: { cause: code },
    });
  }

  if (!isInside(rootReal, targetReal)) {
    throw blocked("scene path escapes the scene root through a link", requestPath);
  }

  const targetStat = await stat(targetReal);
  if (!targetStat.isFile()) {
    throw new DemoError("E_SCENE_NOT_FOUND", `scene path is not a regular file: ${relative}`, { url: requestPath });
  }

  assertAllowedExtension(targetReal, requestPath);

  return targetReal;
}
