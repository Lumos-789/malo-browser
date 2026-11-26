import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// 匿名会话的 partition 目录名 = malo-lease-<lease-id>-session-<session-id>；profile 的是 malo-profile-*
const ANONYMOUS_PARTITION_PREFIX = "malo-lease-";
const PROFILE_PARTITION_PREFIX = "malo-profile-";
// 网页缓存与脚本字节码缓存：丢了只是下次加载慢一点，登录态不在这里面
const PROFILE_CACHE_DIRS = ["Cache", "Code Cache"];
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// 租约目录往下三层：leases/<lease-id>/sessions/<session-id>/{downloads,artifacts}
const LEASE_TREE_DEPTH = 3;

export type StartupSweepProfile = {
  name: string;
  lastUsedAtMs: number | undefined;
};

export type StartupSweepOptions = {
  /** 租约目录（下载、失败截图、run report）保留多少小时；0 = 不清理。 */
  artifactTtlHours: number;
  /** 这么多小时没用的 profile 清掉网页缓存；0 = 不清。 */
  profileCacheIdleHours: number;
  /** 这么多天没用的 profile 连同登录态一起删；0 = 不删。 */
  profileTtlDays: number;
  /** 登记在册的 profile 及其最后使用时间。 */
  profiles: StartupSweepProfile[];
};

export type StartupSweepReport = {
  anonymous_partitions: number;
  lease_dirs: number;
  trimmed_profile_caches: number;
  expired_profiles: string[];
  /** 磁盘上有分区目录、登记里却没有的 profile。只报告不删：登记文件丢了的话，删掉的就是全部登录态。 */
  unregistered_profile_partitions: string[];
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function newestMtime(dir: string, depth: number): Promise<number> {
  let newest: number;
  try {
    newest = (await stat(dir)).mtimeMs;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (depth === 0) return newest;
  for (const entry of await listDir(dir)) {
    newest = Math.max(newest, await newestMtime(path.join(dir, entry), depth - 1));
  }
  return newest;
}

/**
 * daemon 启动时（还没有任何会话）清掉上次运行的残留：
 * - 匿名会话的 partition：会话关闭时 Chromium 仍握着文件，rm 之后它退出前又把目录写回来，
 *   所以改在下次启动时清——匿名会话本来就不跨进程存活，没有任何东西能再引用它们。
 * - 闲置 profile 的网页缓存、超过保留期的 profile：此时没有任何会话在用它们，删目录是安全的。
 * - 超过保留时长的租约目录（下载、失败截图、run report）：调用方跑完就读完，之后只是占盘。
 */
export async function sweepStartupData(
  dataDir: string,
  options: StartupSweepOptions,
  now = Date.now(),
): Promise<StartupSweepReport> {
  const report: StartupSweepReport = {
    anonymous_partitions: 0,
    lease_dirs: 0,
    trimmed_profile_caches: 0,
    expired_profiles: [],
    unregistered_profile_partitions: [],
  };

  const partitionsDir = path.join(dataDir, "chromium", "Partitions");
  const registered = new Map(options.profiles.map((profile) => [profile.name, profile.lastUsedAtMs]));
  for (const entry of await listDir(partitionsDir)) {
    if (entry.startsWith(ANONYMOUS_PARTITION_PREFIX)) {
      await rm(path.join(partitionsDir, entry), { recursive: true, force: true });
      report.anonymous_partitions += 1;
      continue;
    }
    if (!entry.startsWith(PROFILE_PARTITION_PREFIX)) continue;
    const name = entry.slice(PROFILE_PARTITION_PREFIX.length);
    const lastUsedAtMs = registered.get(name);
    if (lastUsedAtMs === undefined) {
      report.unregistered_profile_partitions.push(name);
      continue;
    }
    const idleMs = now - lastUsedAtMs;
    const partitionDir = path.join(partitionsDir, entry);
    if (options.profileTtlDays > 0 && idleMs >= options.profileTtlDays * DAY_MS) {
      await rm(partitionDir, { recursive: true, force: true });
      report.expired_profiles.push(name);
      continue;
    }
    if (options.profileCacheIdleHours > 0 && idleMs >= options.profileCacheIdleHours * HOUR_MS) {
      for (const cache of PROFILE_CACHE_DIRS) {
        await rm(path.join(partitionDir, cache), { recursive: true, force: true });
      }
      report.trimmed_profile_caches += 1;
    }
  }

  if (options.artifactTtlHours <= 0) return report;
  const leasesDir = path.join(dataDir, "leases");
  const cutoff = now - options.artifactTtlHours * HOUR_MS;
  for (const entry of await listDir(leasesDir)) {
    const dir = path.join(leasesDir, entry);
    if ((await newestMtime(dir, LEASE_TREE_DEPTH)) > cutoff) continue;
    await rm(dir, { recursive: true, force: true });
    report.lease_dirs += 1;
  }
  return report;
}
