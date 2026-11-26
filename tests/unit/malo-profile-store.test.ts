import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DemoError } from "../../src/shared/errors";
import {
  ProfileStore,
  profilePartition,
  validateProfileName,
} from "../../src/main/malo/profile-store";

async function tempStore(maxProfiles?: number): Promise<{ store: ProfileStore; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "malo-profile-"));
  const file = path.join(dir, "profiles.json");
  return { store: new ProfileStore(file, maxProfiles), file };
}

describe("malo profile names", () => {
  it("accepts safe names and rejects path-like input", () => {
    expect(validateProfileName("work")).toBe("work");
    expect(validateProfileName(" agent-1.v2_x ")).toBe("agent-1.v2_x");
    expect(profilePartition("work")).toBe("persist:malo-profile-work");

    for (const bad of ["", " ", "Work", "../escape", "a/b", "x".repeat(65), "-lead"]) {
      expect(() => validateProfileName(bad)).toThrow(DemoError);
    }
    expect(() => validateProfileName(42)).toThrow(DemoError);
  });
});

describe("profile store", () => {
  it("tracks sessions, active counts and reloads from disk", async () => {
    const { store, file } = await tempStore();
    await store.touch("work");
    await store.touch("work");

    const [profile] = await store.list();
    expect(profile.name).toBe("work");
    expect(profile.sessions).toBe(2);
    expect(profile.active_sessions).toBe(2);

    store.releaseActive("work");
    expect(store.activeCount("work")).toBe(1);

    const reloaded = new ProfileStore(file);
    const [restored] = await reloaded.list();
    expect(restored.sessions).toBe(2);
    expect(restored.active_sessions).toBe(0);
    expect(restored.created_at).toBe(profile.created_at);

    const raw = JSON.parse(await readFile(file, "utf8")) as {
      profiles: Record<string, { sessions: number }>;
    };
    expect(raw.profiles.work.sessions).toBe(2);
  });

  it("removes a profile and enforces the profile cap", async () => {
    const { store } = await tempStore(2);
    await store.touch("a");
    await store.touch("b");
    await expect(store.touch("c")).rejects.toMatchObject({ code: "E_RESOURCE_LIMIT" });

    expect(await store.remove("a")).toBe(true);
    expect(await store.remove("a")).toBe(false);
    expect((await store.list()).map((item) => item.name)).toEqual(["b"]);
    await expect(store.touch("c")).resolves.toMatchObject({ name: "c" });
  });

  it("ignores unknown or invalid entries in an existing file", async () => {
    const { store, file } = await tempStore();
    await store.touch("ok");
    await store.touch("gone");
    const raw = JSON.parse(await readFile(file, "utf8")) as { profiles: Record<string, unknown> };
    raw.profiles["../bad"] = { created_at: "2026-01-01T00:00:00.000Z" };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify(raw));

    const reloaded = new ProfileStore(file);
    expect((await reloaded.list()).map((item) => item.name)).toEqual(["gone", "ok"]);
  });
});

describe("profile store write recovery", () => {
  it("keeps writing after a failed persist instead of poisoning the chain", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "malo-profile-recover-"));
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    // mkdir(dirname) fails with ENOTDIR while the blocker is a regular file.
    const file = path.join(blocker, "profiles.json");
    const store = new ProfileStore(file);

    await expect(store.touch("work")).rejects.toBeTruthy();

    await rm(blocker, { force: true });
    await mkdir(blocker);
    await expect(store.touch("work")).resolves.toMatchObject({ name: "work" });

    const reloaded = new ProfileStore(file);
    expect((await reloaded.list()).map((item) => item.name)).toEqual(["work"]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("profile store lifecycle helpers", () => {
  async function seeded(lastUsed: Record<string, string>) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "malo-profile-idle-"));
    const file = path.join(dir, "profiles.json");
    const profiles = Object.fromEntries(
      Object.entries(lastUsed).map(([name, last_used_at]) => [
        name,
        { created_at: last_used_at, last_used_at, sessions: 1 },
      ]),
    );
    await writeFile(file, JSON.stringify({ version: 1, profiles }));
    const store = new ProfileStore(file);
    await store.load();
    return { store, dir };
  }

  it("lists profiles idle for the given number of days that nobody is using", async () => {
    const NOW = Date.parse("2026-11-26T00:00:00.000Z");
    const DAY = 86_400_000;
    const { store, dir } = await seeded({
      old: new Date(NOW - 40 * DAY).toISOString(),
      edge: new Date(NOW - 30 * DAY).toISOString(),
      recent: new Date(NOW - 3 * DAY).toISOString(),
    });
    store.registerActive("old");
    store.addPending("edge");

    expect(store.idleProfiles(30, NOW)).toEqual([]);
    store.releaseActive("old");
    store.releasePending("edge");
    expect(store.idleProfiles(30, NOW)).toEqual(["edge", "old"]);
    expect(store.idleProfiles(60, NOW)).toEqual([]);
    expect(store.lastUsedAtMs("old")).toBe(NOW - 40 * DAY);
    expect(store.lastUsedAtMs("missing")).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });

  it("counts sessions still being created as in use", async () => {
    const { store } = await tempStore();
    expect(store.inUseCount("work")).toBe(0);
    store.addPending("work");
    expect(store.inUseCount("work")).toBe(1);
    store.registerActive("work");
    expect(store.inUseCount("work")).toBe(2);
    store.releasePending("work");
    expect(store.inUseCount("work")).toBe(1);
    store.releaseActive("work");
    expect(store.inUseCount("work")).toBe(0);
  });

  it("runs same-name critical sections one at a time and does not let a failure block the next", async () => {
    const { store } = await tempStore();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing = store.withProfileLock("work", async () => {
      order.push("failing-start");
      await gate;
      throw new Error("clear blew up");
    });
    const queued = store.withProfileLock("work", async () => {
      order.push("queued");
    });
    const elsewhere = store.withProfileLock("play", async () => {
      order.push("elsewhere");
    });
    await vi.waitFor(() => expect(order).toEqual(["failing-start", "elsewhere"]));

    release();
    await expect(failing).rejects.toThrow("clear blew up");
    await Promise.all([queued, elsewhere]);

    expect(order).toEqual(["failing-start", "elsewhere", "queued"]);
  });

  it("fails loudly on a corrupt registry file instead of starting with zero profiles", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "malo-profile-corrupt-"));
    const file = path.join(dir, "profiles.json");
    await writeFile(file, "{ not json");
    const store = new ProfileStore(file);

    await expect(store.load()).rejects.toThrow(/登记文件损坏/);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps room for 256 profiles", async () => {
    const { store } = await tempStore();
    for (let index = 0; index < 256; index += 1) {
      await store.touch(`p${index}`);
    }
    await expect(store.touch("one-too-many")).rejects.toMatchObject({ code: "E_RESOURCE_LIMIT" });
  });
});
