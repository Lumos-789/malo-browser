import type { Session } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DemoError } from "../shared/errors";
import { resolveScenePath } from "./security";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const registered = new WeakSet<Session>();

/**
 * `protocol.handle` on the module only covers the default session; the Stage
 * runs in its own partition, so the handler has to be installed per session.
 */
export function registerDemoProtocol(session: Session, scenesRoot: string): void {
  if (registered.has(session)) return;
  registered.add(session);

  session.protocol.handle("demo", async (request) => {
    try {
      if (process.env.DEMO_DEBUG) console.error(`[malo-browser] demo:// request ${request.url}`);
      const url = new URL(request.url);
      const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
      const sceneId = segments.shift();
      if (!sceneId) throw new DemoError("E_SCENE_NOT_FOUND", `demo URL 缺少场景 id：${request.url}`);
      const relative = segments.join("/") || "index.html";
      const file = await resolveScenePath(path.join(scenesRoot, sceneId), relative);
      const body = await readFile(file);
      if (process.env.DEMO_DEBUG) console.error(`[malo-browser] demo:// serving ${file} (${body.length} bytes)`);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(new Uint8Array(body), { headers: { "content-type": type } });
    } catch (error) {
      console.error(`[malo-browser] demo:// 加载失败：${(error as Error).message}`);
      return new Response(`demo protocol error: ${(error as Error).message}`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  });
}
