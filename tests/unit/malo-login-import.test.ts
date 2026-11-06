import { describe, expect, it } from "vitest";
import { DemoError } from "../../src/shared/errors";
import {
  cookieToDetails,
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
