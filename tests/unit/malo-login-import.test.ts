import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Session } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoError } from "../../src/shared/errors";
import {
  cookieToDetails,
  importLoginState,
  matchesDomains,
  validateCdpUrl,
  type CdpCookie,
} from "../../src/main/malo/login-import";

const NOW = 1_800_000_000;

function cookie(overrides: Partial<CdpCookie> = {}): CdpCookie {
  return {
    name: "session",
    value: "abc",
    domain: "example.com",
    path: "/",
    ...overrides,
  };
}

describe("validateCdpUrl", () => {
  it("接受回环 http 端点", () => {
    expect(validateCdpUrl("http://127.0.0.1:9223").port).toBe("9223");
    expect(validateCdpUrl("http://localhost:9222").hostname).toBe("localhost");
    expect(validateCdpUrl("http://[::1]:9222").hostname).toBe("[::1]");
  });

  it("拒绝非回环地址与非 http 协议", () => {
    expect(() => validateCdpUrl("http://192.168.1.5:9222")).toThrow(DemoError);
    expect(() => validateCdpUrl("http://example.com:9222")).toThrow(DemoError);
    expect(() => validateCdpUrl("ws://127.0.0.1:9222")).toThrow(DemoError);
    expect(() => validateCdpUrl("https://127.0.0.1:9222")).toThrow(DemoError);
    expect(() => validateCdpUrl("不是 url")).toThrow(DemoError);
  });
});

describe("matchesDomains", () => {
  it("无过滤时全过", () => {
    expect(matchesDomains("anything.com", undefined)).toBe(true);
    expect(matchesDomains("anything.com", [])).toBe(true);
  });

  it("精确与子域双向匹配", () => {
    expect(matchesDomains("example.com", ["example.com"])).toBe(true);
    expect(matchesDomains(".example.com", ["example.com"])).toBe(true);
    expect(matchesDomains("sso.example.com", ["example.com"])).toBe(true);
    expect(matchesDomains("example.com", ["sso.example.com"])).toBe(true);
    expect(matchesDomains("example.com", ["example.org"])).toBe(false);
    // 前缀相似但非子域的不匹配
    expect(matchesDomains("fake-example.com", ["example.com"])).toBe(false);
  });
});

describe("cookieToDetails", () => {
  it("host-only cookie 不落 domain 参数", () => {
    const details = cookieToDetails(cookie({ domain: "example.com", secure: true }), NOW, 180);
    expect(details.domain).toBeUndefined();
    expect(details.url).toBe("https://example.com/");
    expect(details.secure).toBe(true);
  });

  it("domain cookie（前导点）保留 domain", () => {
    const details = cookieToDetails(
      cookie({ domain: ".example.com", path: "/app" }),
      NOW,
      180,
    );
    expect(details.domain).toBe(".example.com");
    expect(details.url).toBe("http://example.com/app");
    expect(details.path).toBe("/app");
  });

  it("持久 cookie 透传 expires", () => {
    const details = cookieToDetails(cookie({ expires: NOW + 3_600 }), NOW, 180);
    expect(details.expirationDate).toBe(NOW + 3_600);
  });

  it("session cookie 默认固化为 ttl 天后的持久 cookie", () => {
    const details = cookieToDetails(cookie({ session: true }), NOW, 180);
    expect(details.expirationDate).toBe(NOW + 180 * 86_400);
  });

  it("ttl=0 时 session cookie 保持 session（不给 expirationDate）", () => {
    const details = cookieToDetails(cookie({ session: true }), NOW, 0);
    expect(details.expirationDate).toBeUndefined();
  });

  it("expires<=0 视为 session cookie", () => {
    const details = cookieToDetails(cookie({ expires: 0 }), NOW, 180);
    expect(details.expirationDate).toBe(NOW + 180 * 86_400);
  });

  it("sameSite 映射到 Electron 值，未知值不传", () => {
    expect(cookieToDetails(cookie({ sameSite: "Strict" }), NOW, 180).sameSite).toBe("strict");
    expect(cookieToDetails(cookie({ sameSite: "Lax" }), NOW, 180).sameSite).toBe("lax");
    expect(cookieToDetails(cookie({ sameSite: "None" }), NOW, 180).sameSite).toBe("no_restriction");
    expect(cookieToDetails(cookie({ sameSite: "Weird" }), NOW, 180).sameSite).toBeUndefined();
    expect(cookieToDetails(cookie(), NOW, 180).sameSite).toBeUndefined();
  });

  it("httpOnly 与缺省 path 落默认值", () => {
    const details = cookieToDetails(
      cookie({ httpOnly: true, path: "" }),
      NOW,
      180,
    );
    expect(details.httpOnly).toBe(true);
    expect(details.path).toBe("/");
  });
});

// —— importLoginState 端到端：本地起一个假 CDP 源端点（HTTP /json/version +
// 手写 WebSocket 握手/帧），复现审查者报告的坏帧与非回环 webSocketDebuggerUrl ——

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeWsFrame(binary: boolean, payload: Buffer): Buffer {
  const head = Buffer.alloc(2);
  head[0] = binary ? 0x82 : 0x81;
  let length: Buffer;
  if (payload.length < 126) {
    head[1] = payload.length;
    length = Buffer.alloc(0);
  } else {
    head[1] = 126;
    length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length, 0);
  }
  return Buffer.concat([head, length, payload]);
}

type SourceFrame = { binary?: boolean; payload: string | Buffer };

type CdpSource = { httpUrl: string; upgrades: () => number; close: () => Promise<void> };

function startCdpSource(opts: {
  frames?: SourceFrame[];
  webSocketDebuggerUrl?: string;
}): Promise<CdpSource> {
  let port = 0;
  let upgradeCount = 0;
  // upgrade 后的 socket 不再归 http server 管，closeAllConnections 够不着，得自己记账
  const upgradedSockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    if (req.url !== "/json/version") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "Chrome/131.0.0.0",
        webSocketDebuggerUrl:
          opts.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/devtools/browser/test`,
      }),
    );
  });
  server.on("upgrade", (req, socket) => {
    upgradeCount += 1;
    upgradedSockets.add(socket);
    socket.on("close", () => upgradedSockets.delete(socket));
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    for (const frame of opts.frames ?? []) {
      const payload = Buffer.isBuffer(frame.payload)
        ? frame.payload
        : Buffer.from(frame.payload, "utf8");
      socket.write(encodeWsFrame(frame.binary === true, payload));
    }
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as net.AddressInfo).port;
      resolve({
        httpUrl: `http://127.0.0.1:${port}`,
        upgrades: () => upgradeCount,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of upgradedSockets) socket.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const sourceClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(sourceClosers.splice(0).map((close) => close()));
});

const NO_PARTITION = null as unknown as Session;

describe("importLoginState：源端点帧处理", () => {
  it("正常响应帧：cookie 解析并写入 partition", async () => {
    const source = await startCdpSource({
      frames: [
        {
          payload: JSON.stringify({
            id: 1,
            result: { cookies: [cookie({ name: "sid", value: "v" })] },
          }),
        },
      ],
    });
    sourceClosers.push(source.close);
    const set = vi.fn(async () => undefined);
    const partition = { cookies: { set } } as unknown as Session;
    const result = await importLoginState(partition, { cdp_url: source.httpUrl });
    expect(result.cookies_total).toBe(1);
    expect(result.cookies_matched).toBe(1);
    expect(result.cookies_written).toBe(1);
    expect(set).toHaveBeenCalledOnce();
  });

  it("非 JSON 文本帧：本次 import 以 502 码拒绝，进程存活", async () => {
    const source = await startCdpSource({ frames: [{ payload: "not-json{{" }] });
    sourceClosers.push(source.close);
    await expect(importLoginState(NO_PARTITION, { cdp_url: source.httpUrl })).rejects.toMatchObject({
      code: "E_IMPORT_SOURCE_UNREACHABLE",
      message: expect.stringContaining("帧无法解析"),
    });
  });

  it("二进制帧：同样以 502 码拒绝，而不是抛 SyntaxError 炸掉进程", async () => {
    const source = await startCdpSource({
      frames: [{ binary: true, payload: Buffer.from([0x00, 0x01, 0x02, 0xff]) }],
    });
    sourceClosers.push(source.close);
    await expect(importLoginState(NO_PARTITION, { cdp_url: source.httpUrl })).rejects.toMatchObject({
      code: "E_IMPORT_SOURCE_UNREACHABLE",
      message: expect.stringContaining("帧无法解析"),
    });
  });

  it("webSocketDebuggerUrl 指向非回环地址：400 拒绝且不发起 WS 连接", async () => {
    const source = await startCdpSource({
      webSocketDebuggerUrl: "ws://192.168.1.5:9222/devtools/browser/test",
    });
    sourceClosers.push(source.close);
    await expect(importLoginState(NO_PARTITION, { cdp_url: source.httpUrl })).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
      message: expect.stringContaining("webSocketDebuggerUrl 只允许回环地址"),
    });
    expect(source.upgrades()).toBe(0);
  });
});
