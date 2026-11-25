import crypto from "node:crypto";

export type LeaseRecord = {
  id: string;
  agentId: string;
  /**
   * 持有者标识（客户端进程级唯一）。同 agent 名且同持有者才复用租约：不同进程即使
   * 用同一个 agent 名也各拿各的租约，谁 release 都放不掉对方的会话。
   * null = 没带持有者的旧客户端，只按 agent 名复用（也不接管带持有者的租约）。
   */
  holderId: string | null;
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

  create(
    agentId: string,
    port: number,
    now = Date.now(),
    holderId: string | null = null,
  ): LeaseRecord {
    const normalized = agentId.trim();
    if (normalized === "") throw new Error("agent_id 不能为空");
    const record: LeaseRecord = {
      id: `lease-${crypto.randomUUID()}`,
      agentId: normalized,
      holderId,
      port,
      token: crypto.randomBytes(32).toString("hex"),
      createdAtMs: now,
      expiresAtMs: now + this.ttlMs,
      lastHeartbeatMs: now,
    };
    this.leases.set(record.id, record);
    return record;
  }

  findByOwner(agentId: string, holderId: string | null): LeaseRecord | undefined {
    const normalized = agentId.trim();
    return [...this.leases.values()].find(
      (lease) => lease.agentId === normalized && lease.holderId === holderId,
    );
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

  /**
   * 回收到期的租约。`keep` 返回 true 的租约不回收而是续一期——留给「有请求正在处理」的
   * 租约：客户端活着在等一个长操作的结果，单条请求跑得比 TTL 长不该被腰斩。
   */
  expire(now = Date.now(), keep?: (lease: LeaseRecord) => boolean): LeaseRecord[] {
    const expired: LeaseRecord[] = [];
    for (const lease of this.leases.values()) {
      if (lease.expiresAtMs > now) continue;
      if (keep?.(lease)) {
        lease.expiresAtMs = now + this.ttlMs;
        continue;
      }
      expired.push(lease);
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
