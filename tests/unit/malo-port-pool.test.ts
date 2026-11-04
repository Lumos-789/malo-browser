import { describe, expect, it } from "vitest";
import { LeaseManager } from "../../src/main/malo/lease-manager";
import { PortPool } from "../../src/main/malo/port-pool";

describe("PortPool", () => {
  it("hands out ports in order and reuses released ports", () => {
    const pool = new PortPool(7411, 7413);
    expect(pool.acquire()).toBe(7411);
    expect(pool.acquire()).toBe(7412);
    expect(pool.acquire()).toBe(7413);
    expect(pool.acquire()).toBeNull();

    pool.release(7412);
    expect(pool.acquire()).toBe(7412);
    expect(pool.snapshot()).toEqual({
      min: 7411,
      max: 7413,
      used: [7411, 7412, 7413],
      blocked: [],
    });
  });

  it("skips blocked ports for the lifetime of the daemon", () => {
    const pool = new PortPool(7500, 7502);
    const first = pool.acquire();
    expect(first).toBe(7500);
    pool.block(7500);
    expect(pool.acquire()).toBe(7501);
    expect(pool.acquire()).toBe(7502);
    expect(pool.acquire()).toBeNull();

    pool.release(7501);
    expect(pool.acquire()).toBe(7501);
    expect(pool.snapshot().blocked).toEqual([7500]);
  });

  it("rejects invalid ranges", () => {
    expect(() => new PortPool(0, 10)).toThrow(/无效端口池/);
    expect(() => new PortPool(10, 9)).toThrow(/无效端口池/);
    expect(() => new PortPool(10, 70000)).toThrow(/无效端口池/);
    expect(() => new PortPool(10.5, 20)).toThrow(/整数/);
  });
});

describe("LeaseManager", () => {
  it("creates an opaque lease with a distinct token and expires it by TTL", () => {
    const manager = new LeaseManager(1_000);
    const lease = manager.create("agent-a", 7411, 1_000);

    expect(lease.agentId).toBe("agent-a");
    expect(lease.port).toBe(7411);
    expect(lease.token).toMatch(/^[0-9a-f]{64}$/);
    expect(lease.expiresAtMs).toBe(2_000);
    expect(manager.getByPort(7411)?.id).toBe(lease.id);

    expect(manager.expire(1_999)).toEqual([]);
    const expired = manager.expire(2_000);
    expect(expired.map((item) => item.id)).toEqual([lease.id]);
    expect(manager.get(lease.id)).toBeUndefined();
  });

  it("renews the lease on heartbeat", () => {
    const manager = new LeaseManager(1_000);
    const lease = manager.create("agent-a", 7411, 0);
    const renewed = manager.heartbeat(lease.id, 700);
    expect(renewed.lastHeartbeatMs).toBe(700);
    expect(renewed.expiresAtMs).toBe(1_700);
    expect(manager.expire(1_699)).toEqual([]);
  });

  it("rejects an empty agent id and reports missing leases", () => {
    const manager = new LeaseManager(1_000);
    expect(() => manager.create("   ", 7411)).toThrow(/agent_id/);
    expect(() => manager.heartbeat("missing")).toThrow(/不存在/);
    expect(() => new LeaseManager(0)).toThrow(/TTL/);
  });
});
