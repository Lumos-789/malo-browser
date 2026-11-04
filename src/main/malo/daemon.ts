import crypto from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError, isDemoError } from "../../shared/errors";
import type { MaloLease } from "../../shared/malo";
import { startBrokerServer, type BrokerServer } from "./broker-server";
import { startLeaseServer, type LeaseServer } from "./lease-server";
import { LeaseManager, type LeaseRecord } from "./lease-manager";
import { LOOPBACK } from "./http";
import { PortPool } from "./port-pool";
import { ProfileStore } from "./profile-store";
import { SessionManager } from "./session-manager";

export type MaloDaemonOptions = {
  brokerPort: number;
  portMin: number;
  portMax: number;
  leaseTtlMs: number;
  sessionIdleMs: number;
  maxSessionsPerLease: number;
  dataDir: string;
  brokerToken?: string;
  reaperIntervalMs?: number;
};

type LeaseRuntime = {
  manager: SessionManager;
  server: LeaseServer;
};

export type MaloDaemon = {
  endpoint: string;
  brokerFile: string;
  close(): Promise<void>;
};

function publicLease(lease: LeaseRecord): MaloLease {
  return {
    lease_id: lease.id,
    agent_id: lease.agentId,
    endpoint: `http://${LOOPBACK}:${lease.port}`,
    token: lease.token,
    expires_at: new Date(lease.expiresAtMs).toISOString(),
  };
}

function isPortInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  return message.includes("端口被占用") || cause?.code === "EADDRINUSE";
}

type BrokerFile = { endpoint: string; token: string; pid: number };

async function readExistingBroker(file: string): Promise<BrokerFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BrokerFile>;
    if (
      typeof parsed.endpoint === "string" &&
      typeof parsed.token === "string" &&
      Number.isInteger(parsed.pid)
    ) {
      const endpoint = new URL(parsed.endpoint);
      if (
        endpoint.protocol !== "http:" ||
        (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost")
      ) {
        throw new Error(`broker 文件的 endpoint 不是回环地址：${parsed.endpoint}（${file}）`);
      }
      return parsed as BrokerFile;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("不是回环地址")) throw error;
    // fall through to the explicit stale-file warning below
  }
  console.error(`[malo] broker 文件损坏，将覆盖：${file}`);
  return null;
}

async function brokerAnswers(endpoint: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`, {
      headers: { "x-malo-broker-token": token },
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function launchMaloDaemon(options: MaloDaemonOptions): Promise<MaloDaemon> {
  if (options.brokerPort >= options.portMin && options.brokerPort <= options.portMax) {
    throw new Error(
      `broker 端口 ${options.brokerPort} 不能位于 lease 端口池 ${options.portMin}-${options.portMax} 内`,
    );
  }
  const dataDir = path.resolve(options.dataDir);
  const brokerFile = path.join(dataDir, "broker.json");
  await mkdir(dataDir, { recursive: true });
  const profileStore = new ProfileStore(path.join(dataDir, "profiles.json"));
  await profileStore.load();
  const previous = await readExistingBroker(brokerFile);
  if (previous) {
    if (await brokerAnswers(previous.endpoint, previous.token)) {
      throw new Error(
        `已有 malo-browser daemon 在运行：${previous.endpoint}（pid ${previous.pid}）。` +
          `请复用该实例，或先停止它；broker 文件：${brokerFile}`,
      );
    }
    if (pidAlive(previous.pid)) {
      throw new Error(
        `broker 文件指向仍在运行的进程 pid ${previous.pid}，但 ${previous.endpoint}/health 无响应。` +
          `请确认或结束该进程后再启动；broker 文件：${brokerFile}`,
      );
    }
    console.error(`[malo] 覆盖陈旧 broker 文件：${brokerFile}`);
  }
  const brokerToken = options.brokerToken ?? crypto.randomBytes(32).toString("hex");
  const pool = new PortPool(options.portMin, options.portMax);
  const leases = new LeaseManager(options.leaseTtlMs);
  const runtimes = new Map<string, LeaseRuntime>();

  const teardownLease = async (lease: LeaseRecord, reason: string): Promise<void> => {
    const runtime = runtimes.get(lease.id);
    runtimes.delete(lease.id);
    if (runtime) await runtime.server.close();
    pool.release(lease.port);
    console.error(`[malo] lease ${lease.id} released (${reason})`);
  };

  const releaseLease = async (id: string, reason: string): Promise<void> => {
    const lease = leases.remove(id);
    if (!lease) throw new DemoError("E_LEASE_NOT_FOUND", `lease 不存在：${id}`);
    await teardownLease(lease, reason);
  };

  let broker: BrokerServer;
  broker = await startBrokerServer({
    port: options.brokerPort,
    token: brokerToken,
    createLease: async (agentId) => {
      const normalized = agentId.trim();
      const existing = leases.list().find((lease) => lease.agentId === normalized);
      if (existing) {
        if (existing.expiresAtMs > Date.now()) return publicLease(existing);
        try {
          await releaseLease(existing.id, "expired-before-reuse");
        } catch (error) {
          if (!isDemoError(error) || error.code !== "E_LEASE_NOT_FOUND") throw error;
        }
      }
      for (let attempt = 0; attempt <= options.portMax - options.portMin + 1; attempt += 1) {
        const port = pool.acquire();
        if (port === null) {
          throw new DemoError(
            "E_RESOURCE_LIMIT",
            `lease 端口池已耗尽：${options.portMin}-${options.portMax}`,
          );
        }
        const lease = leases.create(agentId, port);
        const rootDir = path.join(dataDir, "leases", lease.id, "sessions");
        const manager = new SessionManager({
          leaseId: lease.id,
          rootDir,
          maxSessions: options.maxSessionsPerLease,
          profiles: profileStore,
          partitionsDir: path.join(dataDir, "chromium", "Partitions"),
        });
        try {
          const server = await startLeaseServer({
            port,
            token: lease.token,
            leaseId: lease.id,
            agentId: lease.agentId,
            manager,
            sessionIdleMs: options.sessionIdleMs,
          });
          runtimes.set(lease.id, { manager, server });
          return publicLease(lease);
        } catch (error) {
          leases.remove(lease.id);
          if (isPortInUse(error)) {
            pool.block(port);
            continue;
          }
          pool.release(port);
          throw error;
        }
      }
      throw new DemoError(
        "E_RESOURCE_LIMIT",
        `lease 端口池没有可用端口：${options.portMin}-${options.portMax}`,
      );
    },
    heartbeat: (id) => {
      try {
        const lease = leases.heartbeat(id);
        console.error(`[malo] lease ${id} heartbeat`);
        return lease;
      } catch {
        throw new DemoError("E_LEASE_NOT_FOUND", `lease 不存在：${id}`);
      }
    },
    release: (id) => releaseLease(id, "client-release"),
    list: () => leases.list().map(publicLease),
    state: () => ({
      service: "malo-daemon",
      leases: leases.list().map((lease) => ({
        lease_id: lease.id,
        agent_id: lease.agentId,
        port: lease.port,
        expires_at: new Date(lease.expiresAtMs).toISOString(),
        sessions: runtimes.get(lease.id)?.manager.list() ?? [],
      })),
      ports: pool.snapshot(),
    }),
  });

  const reaper = setInterval(() => {
    void (async () => {
      for (const lease of leases.expire()) {
        try {
          await teardownLease(lease, "expired");
        } catch (error) {
          console.error(`[malo] 回收过期 lease ${lease.id} 失败：${(error as Error).message}`);
        }
      }
    })();
  }, options.reaperIntervalMs ?? 5_000);
  reaper.unref();

  await writeFile(
    brokerFile,
    `${JSON.stringify({ endpoint: broker.url, token: brokerToken, pid: process.pid }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(brokerFile, 0o600);

  let closed = false;
  return {
    endpoint: broker.url,
    brokerFile,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(reaper);
      await Promise.allSettled(
        [...runtimes.keys()].map((id) => releaseLease(id, "daemon-close")),
      );
      await broker.close();
      await rm(brokerFile, { force: true });
    },
  };
}
