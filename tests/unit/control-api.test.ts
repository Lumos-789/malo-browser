import http from "node:http";
import net from "node:net";
import os from "node:os";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppController } from "../../src/main/app-controller";
import type { DirectorSnapshot } from "../../src/preload/director-api";
import { DemoError } from "../../src/shared/errors";
import type { AppEvent, ControlCommand } from "../../src/shared/types";
import { constantTimeTokenMatch, startControlServer, type ControlServer } from "../../src/main/control";
import { dispatchCommand, SUPPORTED_COMMANDS } from "../../src/main/control-dispatch";
import { SUPPORTED_ROUTES } from "../../src/main/control/server";
import { explainListenFailure } from "../../src/main/tools";

const TOKEN = "test-token-0123456789abcdef";

function baseSnapshot(): DirectorSnapshot {
  return {
    schemaVersion: 1,
    app: { version: "0.1.0", electron: "45.1.0", chromium: "156.0.8078.49" },
    stage: {
      sceneId: "report-review",
      title: "Report Review",
      url: "demo://report-review/index.html",
      visible: true,
      blackout: false,
      fullscreen: false,
      displayId: null,
      viewport: { width: 1920, height: 1080, dpr: 1 },
    },
    run: {
      mode: "rehearse",
      status: "ready",
      stepIndex: 0,
      stepTotal: 3,
      steps: [],
      startedAt: null,
      elapsedMs: 0,
    },
    recorder: { status: "idle", outputPath: null, frames: 0, elapsedMs: 0 },
    error: null,
    scenes: [{ id: "report-review", title: "Report Review", stepTotal: 3 }],
    displays: [{ id: 1, label: "Built-in", width: 1920, height: 1080, scaleFactor: 2, primary: true }],
  };
}

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

type Harness = {
  server: ControlServer;
  commands: ControlCommand[];
  listeners: Set<(event: AppEvent) => void>;
  emit(event: AppEvent): void;
  snapshot: DirectorSnapshot;
};

async function startHarness(
  extra: { port?: number; recordFile?: string; heartbeatMs?: number } = {},
): Promise<Harness> {
  const commands: ControlCommand[] = [];
  const listeners = new Set<(event: AppEvent) => void>();
  const snapshot = baseSnapshot();

  const server = await startControlServer({
    token: TOKEN,
    port: extra.port,
    recordFile: extra.recordFile,
    heartbeatMs: extra.heartbeatMs,
    getSnapshot: () => snapshot,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (command) => {
      commands.push(command);
      if (command.cmd === "run.start") throw new DemoError("E_PROFILE_LOCKED", "profile 正在被占用");
      if (command.cmd === "run.next") throw new Error("runner 崩了");
      return { accepted: command.cmd };
    },
  });

  return {
    server,
    commands,
    listeners,
    snapshot,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

let harness: Harness;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "malo-browser-control-"));
  harness = await startHarness();
});

afterEach(async () => {
  await harness.server.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("control api", () => {
  it("serves /health without a token and listens on loopback only", async () => {
    const res = await request(harness.server.port, { path: "/health" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
    expect(harness.server.url).toBe(`http://127.0.0.1:${harness.server.port}`);

    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((info) => info && info.family === "IPv4" && !info.internal);
    if (!external) return;

    const reachable = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: external.address, port: harness.server.port, timeout: 500 });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(false));
    });
    expect(reachable).toBe(false);
  });

  it("rejects requests without a token", async () => {
    const res = await request(harness.server.port, { path: "/state" });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("E_CONTROL_UNAUTHORIZED");
  });

  it("rejects a wrong token and accepts both header styles", async () => {
    const wrong = await request(harness.server.port, {
      path: "/state",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);

    const bearer = await request(harness.server.port, { path: "/state", headers: authed() });
    expect(bearer.status).toBe(200);
    expect(JSON.parse(bearer.body).stage.sceneId).toBe("report-review");

    const custom = await request(harness.server.port, {
      path: "/scenes",
      headers: { "x-demo-token": TOKEN },
    });
    expect(custom.status).toBe(200);
    expect(JSON.parse(custom.body).scenes).toHaveLength(1);
  });

  it("rejects a foreign Host header", async () => {
    const res = await request(harness.server.port, {
      path: "/health",
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("E_CONTROL_FORBIDDEN");
  });

  it("dispatches a valid command", async () => {
    const res = await request(harness.server.port, {
      method: "POST",
      path: "/command",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ cmd: "stage.blackout", args: { on: true } }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, result: { accepted: "stage.blackout" } });
    expect(harness.commands).toEqual([{ cmd: "stage.blackout", args: { on: true } }]);
  });

  it("maps command failures to non-2xx with code and message", async () => {
    const conflict = await request(harness.server.port, {
      method: "POST",
      path: "/command",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ cmd: "run.start", args: { mode: "rehearse" } }),
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body).error).toEqual({
      code: "E_PROFILE_LOCKED",
      message: "E_PROFILE_LOCKED: profile 正在被占用",
    });

    const internal = await request(harness.server.port, {
      method: "POST",
      path: "/command",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ cmd: "run.next", args: {} }),
    });
    expect(internal.status).toBe(500);
    expect(JSON.parse(internal.body).error.code).toBe("E_CONTROL_INTERNAL");
  });

  it("validates content-type, JSON and payload size", async () => {
    const wrongType = await request(harness.server.port, {
      method: "POST",
      path: "/command",
      headers: authed({ "content-type": "text/plain" }),
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const badJson = await request(harness.server.port, {
      method: "POST",
      path: "/command",
      headers: authed({ "content-type": "application/json" }),
      body: "{not json",
    });
    expect(badJson.status).toBe(400);

    const tooLarge = await request(harness.server.port, {
      method: "POST",
      path: "/command",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ cmd: "run.next", args: {}, pad: "x".repeat(1024 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(harness.commands).toHaveLength(0);
  });

  it("returns 404 for unknown routes and adds no CORS headers", async () => {
    const res = await request(harness.server.port, { path: "/nope", headers: authed() });
    expect(res.status).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("lists every supported route in the 404 message", async () => {
    const res = await request(harness.server.port, { path: "/commands", headers: authed() });
    expect(res.status).toBe(404);
    const message = JSON.parse(res.body).error.message as string;
    expect(message).toContain("未知路由 GET /commands");
    for (const route of SUPPORTED_ROUTES) {
      expect(message).toContain(route);
    }
  });

  it("keeps SUPPORTED_ROUTES in sync with the routes server.ts actually matches", async () => {
    const source = await readFile(
      path.resolve(__dirname, "../../src/main/control/server.ts"),
      "utf8",
    );
    const matched = [...source.matchAll(/route === "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(matched)).toEqual(new Set(SUPPORTED_ROUTES));
  });

  it("lists every supported command when an unknown command is dispatched", async () => {
    const error = await dispatchCommand({} as AppController, { cmd: "next", args: {} } as ControlCommand).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DemoError);
    expect((error as DemoError).code).toBe("E_UNSUPPORTED");
    const message = (error as DemoError).message;
    expect(message).toContain("未知命令 next");
    for (const cmd of Object.keys(SUPPORTED_COMMANDS)) {
      expect(message).toContain(cmd);
    }
  });

  it("streams app events over SSE and unsubscribes on disconnect", async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: harness.server.port,
          path: "/events",
          headers: authed(),
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\n\n") && buffer.includes("data:")) {
              req.destroy();
              resolve(buffer);
            }
          });
        },
      );
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      req.end();

      setTimeout(() => harness.emit({ type: "scene.loading", sceneId: "report-review" }), 100);
      setTimeout(() => reject(new Error("SSE 超时")), 3000);
    });

    expect(received).toContain('"type":"scene.loading"');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.listeners.size).toBe(0);
    expect(() => harness.emit({ type: "run.completed", stepTotal: 0 })).not.toThrow();
  });

  it("keeps /events alive with comment heartbeats", async () => {
    const beat = await startHarness({ heartbeatMs: 50 });
    try {
      const received = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: beat.server.port,
            path: "/events",
            headers: authed(),
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            let buffer = "";
            res.on("data", (chunk: Buffer) => {
              buffer += chunk.toString("utf8");
              const pings = (buffer.match(/: ping/g) ?? []).length;
              if (buffer.includes(": connected") && pings >= 2) {
                req.destroy();
                resolve(buffer);
              }
            });
          },
        );
        req.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
        });
        req.end();
        setTimeout(() => reject(new Error("心跳超时")), 3000);
      });

      const frames = received.split("\n\n").filter(Boolean);
      expect(frames[0]).toBe("retry: 1000");
      expect(frames[1]).toBe(": connected");
      expect(frames.filter((frame) => frame === ": ping").length).toBeGreaterThanOrEqual(2);
      expect(frames.some((frame) => frame.startsWith("data:"))).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(beat.listeners.size).toBe(0);
    } finally {
      await beat.server.close();
    }
  });

  it("rejects a non-positive heartbeat interval", async () => {
    await expect(startHarness({ heartbeatMs: 0 })).rejects.toThrow("心跳间隔");
  });

  it("writes the record file with 0600 permissions", async () => {
    const recordFile = path.join(tempDir, "nested", "control.json");
    await mkdir(path.dirname(recordFile), { recursive: true });
    await writeFile(recordFile, "stale", { mode: 0o644 });
    await chmod(recordFile, 0o644);

    const extra = await startHarness({ recordFile });
    try {
      const mode = (await stat(recordFile)).mode & 0o777;
      expect(mode).toBe(0o600);
      const record = JSON.parse(await readFile(recordFile, "utf8"));
      expect(record).toEqual({ url: extra.server.url, token: TOKEN, pid: process.pid });
    } finally {
      await extra.server.close();
    }
  });

  it("compares tokens in constant time and rejects length mismatches", () => {
    expect(constantTimeTokenMatch("abc", "abc")).toBe(true);
    expect(constantTimeTokenMatch("abc", "abd")).toBe(false);
    expect(constantTimeTokenMatch("abc", "abcd")).toBe(false);
  });

  it("rewrites a raw EADDRINUSE listen failure into a self-service guide", () => {
    const original = Object.assign(
      new Error("listen EADDRINUSE: address already in use 127.0.0.1:7317"),
      { code: "EADDRINUSE" },
    );
    const explained = explainListenFailure(7317, original) as Error;
    expect(explained).not.toBe(original);
    expect(explained.message).toContain("控制 API 端口被占用");
    expect(explained.message).toContain("127.0.0.1:7317");
    expect(explained.message).toContain("另一个 malo-browser 实例");
    expect(explained.message).toContain("--control-port=<n>");
    expect(explained.message).toContain("listen EADDRINUSE");
    expect(explained.cause).toBe(original);

    const randomPort = explainListenFailure(0, original) as Error;
    expect(randomPort.message).not.toContain("127.0.0.1:0");
    expect(randomPort.message).toContain("请求的回环地址");

    const other = Object.assign(new Error("listen EACCES: permission denied 80"), { code: "EACCES" });
    expect(explainListenFailure(7317, other)).toBe(other);
  });

  it("rejects with the explained message when the control port is already taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const failure = await startControlServer({
        token: TOKEN,
        port,
        getSnapshot: baseSnapshot,
        onEvent: () => () => {},
        send: async () => null,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("控制 API 端口被占用");
      expect(message).toContain(`127.0.0.1:${port}`);
      expect(message).toContain("--control-port=<n>");
      expect((failure as Error).cause).toBeInstanceOf(Error);
    } finally {
      blocker.close();
    }
  });
});
