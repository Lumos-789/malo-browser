import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  sweepStartupData,
  type StartupSweepOptions,
  type StartupSweepProfile,
} from "../../src/main/malo/startup-sweep";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
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

const options = (overrides: Partial<StartupSweepOptions> = {}): StartupSweepOptions => ({
  artifactTtlHours: 168,
  profileCacheIdleHours: 72,
  profileTtlDays: 0,
  profiles: [],
  ...overrides,
});

const profile = (name: string, idleMs: number): StartupSweepProfile => ({
  name,
  lastUsedAtMs: NOW - idleMs,
});

const emptyReport = {
  anonymous_partitions: 0,
  lease_dirs: 0,
  trimmed_profile_caches: 0,
  expired_profiles: [],
  unregistered_profile_partitions: [],
};

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

    const report = await sweepStartupData(
      dir,
      options({ profiles: [profile("work", 60_000)] }),
      NOW,
    );

    expect(report).toEqual({ ...emptyReport, anonymous_partitions: 2 });
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

    const report = await sweepStartupData(dir, options(), NOW);

    expect(report).toEqual({ ...emptyReport, lease_dirs: 1 });
    expect(await entries(path.join(dir, "leases"))).toEqual(["fresh", "touched"]);
  });

  it("keeps every lease dir when retention is disabled", async () => {
    const dir = await dataDir();
    await touch(dir, path.join(dir, "leases", "old", "downloads", "a.zip"), 365 * 24 * HOUR);

    const report = await sweepStartupData(dir, options({ artifactTtlHours: 0 }), NOW);

    expect(report).toEqual(emptyReport);
    expect(await entries(path.join(dir, "leases"))).toEqual(["old"]);
  });

  it("reports nothing to do on a first run", async () => {
    const dir = await dataDir();
    expect(await sweepStartupData(dir, options(), NOW)).toEqual(emptyReport);
  });
});

describe("startup sweep of profile partitions", () => {
  async function seed(dir: string, name: string, ageMs: number): Promise<string> {
    const partition = path.join(dir, "chromium", "Partitions", `malo-profile-${name}`);
    for (const file of ["Cache/data_0", "Code Cache/js/index", "Cookies", "Local Storage/leveldb/LOG"]) {
      await touch(dir, path.join(partition, file), ageMs);
    }
    return partition;
  }

  it("trims only the web caches of a profile that has been idle long enough", async () => {
    const dir = await dataDir();
    const idle = await seed(dir, "idle", 4 * DAY);
    const busy = await seed(dir, "busy", HOUR);

    const report = await sweepStartupData(
      dir,
      options({ profiles: [profile("idle", 4 * DAY), profile("busy", HOUR)] }),
      NOW,
    );

    expect(report).toEqual({ ...emptyReport, trimmed_profile_caches: 1 });
    await expect(entries(idle)).resolves.toEqual(["Cookies", "Local Storage"]);
    await expect(entries(busy)).resolves.toEqual(["Cache", "Code Cache", "Cookies", "Local Storage"]);
  });

  it("leaves caches alone when cache trimming is disabled", async () => {
    const dir = await dataDir();
    const idle = await seed(dir, "idle", 400 * DAY);

    const report = await sweepStartupData(
      dir,
      options({ profileCacheIdleHours: 0, profiles: [profile("idle", 400 * DAY)] }),
      NOW,
    );

    expect(report).toEqual(emptyReport);
    expect(await entries(idle)).toContain("Cache");
  });

  it("deletes a profile outright only when a TTL is configured and it has expired", async () => {
    const dir = await dataDir();
    const stale = await seed(dir, "stale", 40 * DAY);
    const recent = await seed(dir, "recent", 29 * DAY);
    const profiles = [profile("stale", 40 * DAY), profile("recent", 29 * DAY)];

    const off = await sweepStartupData(
      dir,
      options({ profileTtlDays: 0, profileCacheIdleHours: 0, profiles }),
      NOW,
    );
    expect(off).toEqual(emptyReport);
    expect(await entries(stale)).toContain("Cookies");

    const on = await sweepStartupData(
      dir,
      options({ profileTtlDays: 30, profileCacheIdleHours: 0, profiles }),
      NOW,
    );
    expect(on).toEqual({ ...emptyReport, expired_profiles: ["stale"] });
    await expect(entries(stale)).resolves.toEqual([]);
    expect(await entries(recent)).toContain("Cookies");
  });

  it("reports a profile partition that has no record instead of deleting it", async () => {
    const dir = await dataDir();
    const ghost = await seed(dir, "ghost", 400 * DAY);

    const report = await sweepStartupData(
      dir,
      options({ profileTtlDays: 1, profileCacheIdleHours: 1, profiles: [] }),
      NOW,
    );

    expect(report).toEqual({ ...emptyReport, unregistered_profile_partitions: ["ghost"] });
    expect(await entries(ghost)).toContain("Cookies");
  });
});
