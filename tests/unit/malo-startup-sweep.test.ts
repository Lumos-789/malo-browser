import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepStartupData } from "../../src/main/malo/startup-sweep";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-25T00:00:00.000Z");

const tmpDirs: string[] = [];

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "malo-startup-sweep-"));
  tmpDirs.push(dir);
  return dir;
}

// 写一个文件，并把它到 root 之间每一层目录的 mtime 都拨到同一个时间点
async function touch(root: string, file: string, ageMs: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "x");
  const stamp = new Date(NOW - ageMs);
  await utimes(file, stamp, stamp);
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    await utimes(dir, stamp, stamp);
  }
}

async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("startup sweep", () => {
  it("removes leftover anonymous partitions and keeps profile ones", async () => {
    const dir = await dataDir();
    const partitions = path.join(dir, "chromium", "Partitions");
    await touch(dir, path.join(partitions, "malo-lease-a-session-1", "Cache", "data_0"), 60_000);
    await touch(dir, path.join(partitions, "malo-lease-b-session-2", "Cookies"), HOUR);
    await touch(dir, path.join(partitions, "malo-profile-work", "Cookies"), 60_000);
    await touch(dir, path.join(partitions, "unrelated", "keep"), 60_000);

    const report = await sweepStartupData(dir, 168, NOW);

    expect(report).toEqual({ anonymous_partitions: 2, lease_dirs: 0 });
    expect(await entries(partitions)).toEqual(["malo-profile-work", "unrelated"]);
    await expect(entries(path.join(partitions, "malo-profile-work"))).resolves.toEqual(["Cookies"]);
  });

  it("removes only lease dirs older than the retention window", async () => {
    const dir = await dataDir();
    const sessions = (lease: string, session: string) =>
      path.join(dir, "leases", lease, "sessions", session);
    await touch(dir, path.join(sessions("old", "s1"), "artifacts", "failure.png"), 9 * 24 * HOUR);
    await touch(dir, path.join(sessions("fresh", "s2"), "artifacts", "run.json"), 2 * 24 * HOUR);
    // 租约目录和第一张截图都很旧，但里面昨天才又写进一张：按最新的那个文件算
    await touch(dir, path.join(sessions("touched", "s3"), "artifacts", "stale.png"), 9 * 24 * HOUR);
    const recent = path.join(sessions("touched", "s3"), "artifacts", "recent.png");
    await writeFile(recent, "x");
    await utimes(recent, new Date(NOW - HOUR), new Date(NOW - HOUR));

    const report = await sweepStartupData(dir, 168, NOW);

    expect(report).toEqual({ anonymous_partitions: 0, lease_dirs: 1 });
    expect(await entries(path.join(dir, "leases"))).toEqual(["fresh", "touched"]);
  });

  it("keeps every lease dir when retention is disabled", async () => {
    const dir = await dataDir();
    await touch(dir, path.join(dir, "leases", "old", "downloads", "a.zip"), 365 * 24 * HOUR);

    const report = await sweepStartupData(dir, 0, NOW);

    expect(report).toEqual({ anonymous_partitions: 0, lease_dirs: 0 });
    expect(await entries(path.join(dir, "leases"))).toEqual(["old"]);
  });

  it("reports nothing to do on a first run", async () => {
    const dir = await dataDir();
    expect(await sweepStartupData(dir, 168, NOW)).toEqual({
      anonymous_partitions: 0,
      lease_dirs: 0,
    });
  });
});
