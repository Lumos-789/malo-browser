import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

// 匿名会话的 partition 目录名 = malo-lease-<lease-id>-session-<session-id>；profile 的是 malo-profile-*，永不碰。
const ANONYMOUS_PARTITION_PREFIX = "malo-lease-";
const HOUR_MS = 3_600_000;
// 租约目录往下三层：leases/<lease-id>/sessions/<session-id>/{downloads,artifacts}
const LEASE_TREE_DEPTH = 3;

export type StartupSweepReport = { anonymous_partitions: number; lease_dirs: number };

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
 * - 超过保留时长的租约目录（下载、失败截图、run report）：调用方跑完就读完，之后只是占盘。
 */
export async function sweepStartupData(
  dataDir: string,
  artifactTtlHours: number,
  now = Date.now(),
): Promise<StartupSweepReport> {
  const report: StartupSweepReport = { anonymous_partitions: 0, lease_dirs: 0 };

  const partitionsDir = path.join(dataDir, "chromium", "Partitions");
  for (const entry of await listDir(partitionsDir)) {
    if (!entry.startsWith(ANONYMOUS_PARTITION_PREFIX)) continue;
    await rm(path.join(partitionsDir, entry), { recursive: true, force: true });
    report.anonymous_partitions += 1;
  }

  if (artifactTtlHours <= 0) return report;
  const leasesDir = path.join(dataDir, "leases");
  const cutoff = now - artifactTtlHours * HOUR_MS;
  for (const entry of await listDir(leasesDir)) {
    const dir = path.join(leasesDir, entry);
    if ((await newestMtime(dir, LEASE_TREE_DEPTH)) > cutoff) continue;
    await rm(dir, { recursive: true, force: true });
    report.lease_dirs += 1;
  }
  return report;
}
