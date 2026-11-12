import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { session as electronSession } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../../src/main/malo/browser-session";
import { ProfileStore, profilePartition } from "../../src/main/malo/profile-store";
import { SessionManager } from "../../src/main/malo/session-manager";

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
    })),
  },
}));

vi.mock("../../src/main/malo/browser-session", () => ({
  BrowserSession: { create: vi.fn() },
}));

let sessionSeq = 0;

function fakeSession(profile: string | null): BrowserSession {
  sessionSeq += 1;
  const id = `sess-${sessionSeq}`;
  return {
    id,
    token: `token-${id}`,
    profile,
    summary: () => ({ session_id: id, name: id }),
    close: vi.fn(async () => undefined),
    isClosed: () => false,
    idleMs: () => 0,
    downloadsDir: `/tmp/${id}/downloads`,
    artifactsDir: `/tmp/${id}/artifacts`,
  } as unknown as BrowserSession;
}

const tmpDirs: string[] = [];

async function harness(seedProfile?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "malo-session-manager-"));
  tmpDirs.push(dir);
  const partitionsDir = path.join(dir, "partitions");
  await mkdir(partitionsDir, { recursive: true });
  if (seedProfile !== undefined) {
    const partitionDir = path.join(partitionsDir, profilePartition(seedProfile).replace(/^persist:/, ""));
    await mkdir(partitionDir, { recursive: true });
    await writeFile(path.join(partitionDir, "Cookies"), "stale-login-state");
    await writeFile(
      path.join(dir, "profiles.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            [seedProfile]: {
              created_at: "2026-01-01T00:00:00.000Z",
              last_used_at: "2026-01-01T00:00:00.000Z",
              sessions: 3,
            },
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  const profiles = new ProfileStore(path.join(dir, "profiles.json"));
  await profiles.load();
  const manager = new SessionManager({
    leaseId: "lease-test",
    rootDir: path.join(dir, "sessions"),
    maxSessions: 4,
    profiles,
    partitionsDir,
  });
  return { manager, profiles, partitionsDir, dir };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.allSettled(
    tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("clearProfile 与并发 create 的互斥", () => {
  it("create 进行中（已登记占用）时 clear 拒绝 E_PROFILE_LOCKED，新记录不丢", async () => {
    const { manager, profiles } = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(BrowserSession.create).mockImplementationOnce(async () => {
      await gate;
      return fakeSession("alpha");
    });
    const creating = manager.create({ profile: "alpha" });
    // pending 登记发生在 BrowserSession.create 之前，这里等到 create 已进飞行段
    await vi.waitFor(() => expect(BrowserSession.create).toHaveBeenCalled());

    await expect(manager.clearProfile("alpha")).rejects.toMatchObject({
      code: "E_PROFILE_LOCKED",
    });
    expect(await profiles.exists("alpha")).toBe(false);

    release();
    await creating;
    expect(await profiles.exists("alpha")).toBe(true);
    expect(profiles.activeCount("alpha")).toBe(1);
  });

  it("clear 进行中并发 create 同名：create 等 clear 关键段完成后才占用，分区目录先清、记录重建", async () => {
    const { manager, profiles, partitionsDir } = await harness("alpha");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(electronSession.fromPartition).mockImplementationOnce(
      () =>
        ({
          clearStorageData: vi.fn(async () => {
            await gate;
          }),
          clearCache: vi.fn(async () => undefined),
        }) as never,
    );
    vi.mocked(BrowserSession.create).mockImplementationOnce(async () => fakeSession("alpha"));

    const clearing = manager.clearProfile("alpha");
    // clear 已持有锁并停在 clearStorageData；create 的关键段必须排队
    const creating = manager.create({ profile: "alpha" });
    expect(BrowserSession.create).not.toHaveBeenCalled();

    release();
    await expect(clearing).resolves.toEqual({ profile: "alpha", existed: true });
    await expect(
      access(path.join(partitionsDir, "malo-profile-alpha")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const created = await creating;
    expect(created.session_id).toBeTruthy();
    expect(await profiles.exists("alpha")).toBe(true);
    expect(profiles.activeCount("alpha")).toBe(1);
  });

  it("create 失败后撤销占用登记，clear 不被已放弃的 create 空拒", async () => {
    const { manager } = await harness();
    vi.mocked(BrowserSession.create).mockRejectedValueOnce(new Error("stage create failed"));
    await expect(manager.create({ profile: "alpha" })).rejects.toThrow("stage create failed");
    await expect(manager.clearProfile("alpha")).resolves.toEqual({
      profile: "alpha",
      existed: false,
    });
  });

  it("活跃 session 占用的 profile：clear 仍报 E_PROFILE_LOCKED（原有语义保持）", async () => {
    const { manager, profiles } = await harness();
    vi.mocked(BrowserSession.create).mockImplementationOnce(async () => fakeSession("alpha"));
    await manager.create({ profile: "alpha" });
    await expect(manager.clearProfile("alpha")).rejects.toMatchObject({
      code: "E_PROFILE_LOCKED",
    });
    expect(await profiles.exists("alpha")).toBe(true);
  });

  it("session 关闭释放占用后 clear 可清理并移除分区目录", async () => {
    const { manager, profiles, partitionsDir } = await harness();
    vi.mocked(BrowserSession.create).mockImplementationOnce(async () => fakeSession("alpha"));
    const created = await manager.create({ profile: "alpha" });
    await manager.close(created.session_id);
    expect(profiles.activeCount("alpha")).toBe(0);

    await expect(manager.clearProfile("alpha")).resolves.toEqual({
      profile: "alpha",
      existed: true,
    });
    expect(electronSession.fromPartition).toHaveBeenCalledWith("persist:malo-profile-alpha");
    await expect(
      access(path.join(partitionsDir, "malo-profile-alpha")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
