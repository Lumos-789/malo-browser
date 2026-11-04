import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
