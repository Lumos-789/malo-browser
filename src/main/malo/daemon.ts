import crypto from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError, isDemoError } from "../../shared/errors";
import { publicLease, startBrokerServer, type BrokerServer } from "./broker-server";
import { startLeaseServer, type LeaseServer } from "./lease-server";
import { MALO_FEATURES } from "../../shared/malo-tools";
import { LeaseManager, type LeaseRecord } from "./lease-manager";
import { shouldKeepLease } from "./lease-keep";
import { maloVersion } from "./version";
import { PortPool } from "./port-pool";
import { ProfileStore } from "./profile-store";
import { SessionBudget } from "./session-budget";
import { SessionManager } from "./session-manager";
import { sweepStartupData } from "./startup-sweep";

export type MaloDaemonOptions = {
  brokerPort: number;
  portMin: number;
  portMax: number;
  leaseTtlMs: number;
  sessionIdleMs: number;
  maxSessionsPerLease: number;
  /** daemon 全局的会话上限（各租约合计）。 */
  maxSessionsTotal: number;
  /** 租约目录（下载、失败截图、run report）保留多少小时；0 = 启动时不清理。 */
  artifactTtlHours: number;
  /** 启动时清掉多久没用过的 profile 的网页缓存；0 = 不清。 */
  profileCacheIdleHours: number;
  /** 启动时删掉多久没用过的 profile（连同登录态）；0 = 不删。 */
  profileTtlDays: number;
  /** 允许 watch/login 以 focus=true 把窗口带到前台。 */
  allowFocus?: boolean;
  /** 进程带着 CDP 调试口启动时记下端口号，写进 /health 让客户端看得见。 */
  debugPort?: number | null;
  dataDir: string;
  brokerToken?: string;
  reaperIntervalMs?: number;
  /** 窗口显示给人的会话所属租约，在客户端多久没活动后照常回收；默认 30 分钟，0 = 不宽限。 */
  visibleGraceMs?: number;
  /** 无租约且无请求超过这么久就退出进程；0/不传＝不退出。 */
  idleExitMs?: number;
  /** 空闲退出时回调（由宿主负责真正退出 Electron）。 */
  onIdleExit?: () => void;
};

export type MaloHandshake = {
  version: string;
  features: string[];
  leaseTtlSeconds: number;
  /** 没开调试口时为 null。调试口没有鉴权：开着就等于本机任何进程都能操作全部会话。 */
  debugPort: number | null;
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

function describeSweep(
  swept: Awaited<ReturnType<typeof sweepStartupData>>,
  artifactTtlHours: number,
): string {
  const parts: string[] = [];
  if (swept.anonymous_partitions > 0) parts.push(`匿名分区 ${swept.anonymous_partitions} 个`);
  if (swept.lease_dirs > 0) parts.push(`超过 ${artifactTtlHours}h 的租约目录 ${swept.lease_dirs} 个`);
  if (swept.trimmed_profile_caches > 0) parts.push(`闲置 profile 的网页缓存 ${swept.trimmed_profile_caches} 个`);
  if (swept.expired_profiles.length > 0) parts.push(`过期 profile ${swept.expired_profiles.join(", ")}`);
  return parts.length > 0 ? parts.join("、") : "无残留";
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
  const debugPort = options.debugPort ?? null;
  if (debugPort !== null) {
    console.error(
      `[malo] 警告：CDP 调试口已开启（127.0.0.1:${debugPort}），它没有鉴权——` +
        `本机任何进程连上都能操作这个 daemon 里的全部会话和已登录档案，` +
        `经它做的点击、输入也不会进会话事件。多人多 agent 共用的 daemon 不应开调试口。`,
    );
  }
  const handshake: MaloHandshake = {
    version: maloVersion(),
    features: MALO_FEATURES,
    leaseTtlSeconds: Math.round(options.leaseTtlMs / 1000),
    debugPort,
  };
  const brokerToken = options.brokerToken ?? crypto.randomBytes(32).toString("hex");
  const pool = new PortPool(options.portMin, options.portMax);
  const leases = new LeaseManager(options.leaseTtlMs);
  const budget = new SessionBudget(options.maxSessionsTotal);
  // 上次运行的残留（匿名分区、闲置 profile 的缓存、过期租约目录）在开始监听前清掉：这时还没有任何
  // 会话，不会误删在用的。清理失败不拦启动——残留只是占盘，拦下来等于让所有 agent 都用不了；
  // 但要把原因喊出来。
  try {
    const profiles = (await profileStore.list()).map((profile) => ({
      name: profile.name,
      lastUsedAtMs: profileStore.lastUsedAtMs(profile.name),
    }));
    const swept = await sweepStartupData(dataDir, {
      artifactTtlHours: options.artifactTtlHours,
      profileCacheIdleHours: options.profileCacheIdleHours,
      profileTtlDays: options.profileTtlDays,
      profiles,
    });
    for (const name of swept.expired_profiles) await profileStore.remove(name);
    if (swept.unregistered_profile_partitions.length > 0) {
      console.error(
        `[malo] 有 ${swept.unregistered_profile_partitions.length} 个 profile 分区目录没有登记` +
          `（${swept.unregistered_profile_partitions.join(", ")}）：登录态文件还在但没人认领，` +
          `不会自动删；确认无用后可手动删除 chromium/Partitions/ 下对应目录`,
      );
    }
    console.error(`[malo] 启动清扫：${describeSweep(swept, options.artifactTtlHours)}`);
  } catch (error) {
    console.error(`[malo] 启动清扫失败（不影响会话，残留会继续占盘）：${(error as Error).message}`);
  }
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
    console.error(`[malo] lease ${lease.id} (agent=${lease.agentId}) released (${reason})`);
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
    debugPort,
    createLease: async (agentId, holderId) => {
      touch();
      const normalized = agentId.trim();
      // 同 agent 名 + 同持有者才复用：不同进程即使同名也各拿各的租约，谁 release 都放不掉对方的会话
      const existing = leases.findByOwner(normalized, holderId);
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
        const lease = leases.create(agentId, port, Date.now(), holderId);
        const rootDir = path.join(dataDir, "leases", lease.id, "sessions");
        const manager = new SessionManager({
          leaseId: lease.id,
          rootDir,
          maxSessions: options.maxSessionsPerLease,
          profiles: profileStore,
          partitionsDir: path.join(dataDir, "chromium", "Partitions"),
          budget,
          allowFocus: options.allowFocus,
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
            debugPort,
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
          console.error(
            `[malo] lease ${lease.id} (agent=${lease.agentId}${holderId ? ` holder=${holderId}` : ""}) ` +
              `created on port ${port}`,
          );
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
        if (process.env.DEMO_DEBUG) console.error(`[malo] lease ${id} heartbeat`);
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
      session_budget: { used: budget.count, max: options.maxSessionsTotal },
    }),
  });

  const visibleGraceMs = options.visibleGraceMs ?? 30 * 60_000;
  const reaper = setInterval(() => {
    void (async () => {
      // 有请求正在处理的租约不回收：客户端活着在等一个长操作的结果（长批次、登录等待），
      // 单条请求跑得比 TTL 长不该被腰斩——给它续一期，等这批请求回来再按常规回收。
      // 窗口显示给人的会话同理宽限，但客户端超过宽限期还没动静就照常回收。
      const now = Date.now();
      const expired = leases.expire(now, (lease) => {
        const runtime = runtimes.get(lease.id);
        return shouldKeepLease({
          inflight: runtime?.server.inflight() ?? 0,
          visibleSessions: runtime?.manager.list().filter((session) => session.visible).length ?? 0,
          silentForMs: now - lease.lastHeartbeatMs,
          visibleGraceMs,
        });
      });
      for (const lease of expired) {
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
