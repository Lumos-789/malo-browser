import crypto from "node:crypto";

export type LeaseRecord = {
  id: string;
  agentId: string;
  port: number;
  token: string;
  createdAtMs: number;
  expiresAtMs: number;
  lastHeartbeatMs: number;
};

export class LeaseManager {
  private readonly leases = new Map<string, LeaseRecord>();

  constructor(private readonly ttlMs: number) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`lease TTL 必须是正毫秒数：${ttlMs}`);
    }
  }

  create(agentId: string, port: number, now = Date.now()): LeaseRecord {
    const normalized = agentId.trim();
    if (normalized === "") throw new Error("agent_id 不能为空");
    const record: LeaseRecord = {
      id: `lease-${crypto.randomUUID()}`,
      agentId: normalized,
      port,
      token: crypto.randomBytes(32).toString("hex"),
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      lastHeartbeatMs: now,
    };
    this.leases.set(record.id, record);
    return record;
  }

  get(id: string): LeaseRecord | undefined {
    return this.leases.get(id);
  }

  getByPort(port: number): LeaseRecord | undefined {
    return [...this.leases.values()].find((lease) => lease.port === port);
  }

  heartbeat(id: string, now = Date.now()): LeaseRecord {
    const lease = this.require(id);
    lease.lastHeartbeatMs = now;
    lease.expiresAtMs = now + this.ttlMs;
    return lease;
  }

  remove(id: string): LeaseRecord | undefined {
    const lease = this.leases.get(id);
    if (lease) this.leases.delete(id);
    return lease;
  }

  expire(now = Date.now()): LeaseRecord[] {
    const expired: LeaseRecord[] = [];
    for (const lease of this.leases.values()) {
      if (lease.expiresAtMs <= now) expired.push(lease);
    }
    for (const lease of expired) this.leases.delete(lease.id);
    return expired;
  }

  list(): LeaseRecord[] {
    return [...this.leases.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  private require(id: string): LeaseRecord {
    const lease = this.leases.get(id);
    if (!lease) throw new Error(`lease 不存在：${id}`);
    return lease;
  }
}
