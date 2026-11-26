import { describe, expect, it } from "vitest";
import { shouldKeepLease } from "../../src/main/malo/lease-keep";

const base = { inflight: 0, visibleSessions: 0, silentForMs: 10 * 60_000, visibleGraceMs: 30 * 60_000 };

describe("shouldKeepLease", () => {
  it("有请求在处理中就续期，不管有没有可见窗口", () => {
    expect(shouldKeepLease({ ...base, inflight: 1 })).toBe(true);
    expect(shouldKeepLease({ ...base, inflight: 3, visibleGraceMs: 0 })).toBe(true);
  });

  it("窗口显示给人看时宽限，但客户端超过宽限期还没动静就照常回收", () => {
    expect(shouldKeepLease({ ...base, visibleSessions: 1 })).toBe(true);
    expect(shouldKeepLease({ ...base, visibleSessions: 2, silentForMs: 30 * 60_000 })).toBe(true);
    expect(
      shouldKeepLease({ ...base, visibleSessions: 1, silentForMs: 30 * 60_000 + 1 }),
    ).toBe(false);
  });

  it("没有请求也没有可见窗口的租约不续期", () => {
    expect(shouldKeepLease(base)).toBe(false);
    expect(shouldKeepLease({ ...base, inflight: 0, visibleSessions: 0, silentForMs: 0 })).toBe(false);
  });

  it("宽限期设为 0 等于关闭宽限", () => {
    expect(shouldKeepLease({ ...base, visibleSessions: 1, visibleGraceMs: 0 })).toBe(false);
  });
});
