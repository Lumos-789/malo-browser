import crypto from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError, isDemoError } from "../../shared/errors";
import type { MaloLease } from "../../shared/malo";
import { startBrokerServer, type BrokerServer } from "./broker-server";
import { startLeaseServer, type LeaseServer } from "./lease-server";
import { MALO_FEATURES } from "../../shared/malo-tools";
import { LeaseManager, type LeaseRecord } from "./lease-manager";
import { maloVersion } from "./version";
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
  /** 无租约且无请求超过这么久就退出进程；0/不传＝不退出。 */
  idleExitMs?: number;
  /** 空闲退出时回调（由宿主负责真正退出 Electron）。 */
  onIdleExit?: () => void;
};

export type MaloHandshake = {
  version: string;
  features: string[];
  leaseTtlSeconds: number;
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

function publicLease(lease: LeaseRecord, handshake: MaloHandshake): MaloLease {
  return {
    lease_id: lease.id,
    agent_id: lease.agentId,
    endpoint: `http://${LOOPBACK}:${lease.port}`,
    token: lease.token,
    expires_at: new Date(lease.expiresAtMs).toISOString(),
    version: handshake.version,
    features: handshake.features,
    ttl_seconds: handshake.leaseTtlSeconds,
  };
}

function isPortInUse(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  return message.includes("端口被占用") || cause?.code === "EADDRINUSE";
}

type BrokerFile = {
  endpoint: string;
  token: string;
  pid: number;
  version: string;
  features: string[];
};

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
  // mode applies to newly created directories only: an existing path is left
  // alone (chmod-ing it could tighten a directory the user pointed us at).
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
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
  const handshake: MaloHandshake = {
    version: maloVersion(),
    features: MALO_FEATURES,
    leaseTtlSeconds: Math.round(options.leaseTtlMs / 1000),
  };
  const brokerToken = options.brokerToken ?? crypto.randomBytes(32).toString("hex");
  const pool = new PortPool(options.portMin, options.portMax);
  const leases = new LeaseManager(options.leaseTtlMs);
  // 有活动就不该过期：createLease / heartbeat / 任何 lease 请求都刷新
  let lastActivityMs = Date.now();
  const touch = () => {
    lastActivityMs = Date.now();
  };
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
    version: handshake.version,
    features: handshake.features,
    leaseTtlSeconds: handshake.leaseTtlSeconds,
    createLease: async (agentId) => {
      touch();
      const normalized = agentId.trim();
      const existing = leases.list().find((lease) => lease.agentId === normalized);
      if (existing) {
        if (existing.expiresAtMs > Date.now()) return publicLease(existing, handshake);
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
            version: handshake.version,
            features: handshake.features,
            onActivity: () => {
              touch();
              try {
                leases.heartbeat(lease.id);
              } catch {
                // 租约已被回收：下一次请求自然会 404，这里不打断当前请求
              }
            },
          });
          runtimes.set(lease.id, { manager, server });
          return publicLease(lease, handshake);
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
      touch();
      try {
        const lease = leases.heartbeat(id);
        console.error(`[malo] lease ${id} heartbeat`);
        return lease;
      } catch {
        throw new DemoError("E_LEASE_NOT_FOUND", `lease 不存在：${id}`);
      }
    },
    release: (id) => releaseLease(id, "client-release"),
    list: () => leases.list().map((lease) => publicLease(lease, handshake)),
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
    `${JSON.stringify(
      {
        endpoint: broker.url,
        token: brokerToken,
        pid: process.pid,
        version: handshake.version,
        features: handshake.features,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await chmod(brokerFile, 0o600);

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(reaper);
    if (idleTimer) clearInterval(idleTimer);
    await Promise.allSettled(
      [...runtimes.keys()].map((id) => releaseLease(id, "daemon-close")),
    );
    await broker.close();
    await rm(brokerFile, { force: true });
  };

  // 无租约且长时间没请求就退出：省内存，也让「装了新版本」能自然生效
  const idleExitMs = options.idleExitMs ?? 0;
  const idleTimer =
    idleExitMs > 0
      ? setInterval(() => {
          void (async () => {
            if (closed) return;
            if (leases.list().length > 0) return;
            if (Date.now() - lastActivityMs < idleExitMs) return;
            console.error(
              `[malo] 无租约且 ${Math.round(idleExitMs / 1000)}s 无请求，daemon 退出：${broker.url}`,
            );
            await shutdown();
            options.onIdleExit?.();
          })();
        }, Math.max(1_000, Math.min(30_000, Math.floor(idleExitMs / 4))))
      : null;
  idleTimer?.unref();

  return {
    endpoint: broker.url,
    brokerFile,
    close: shutdown,
  };
}
