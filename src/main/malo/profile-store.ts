import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError } from "../../shared/errors";
import type { MaloProfile } from "../../shared/malo";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PROFILES = 256;

type ProfileRecord = {
  created_at: string;
  last_used_at: string;
  sessions: number;
};

type ProfileFile = {
  version: 1;
  profiles: Record<string, ProfileRecord>;
};

export function validateProfileName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new DemoError("E_BAD_REQUEST", "profile 必须是非空字符串");
  }
  const name = raw.trim();
  if (!NAME_PATTERN.test(name)) {
    throw new DemoError(
      "E_BAD_REQUEST",
      "profile 名只能用小写字母、数字、点、下划线或短横线，最长 64 字符",
    );
  }
  return name;
}

export function profilePartition(name: string): string {
  return `persist:malo-profile-${name}`;
}

export function partitionDirName(partition: string): string {
  return partition.startsWith("persist:") ? partition.slice("persist:".length) : partition;
}

/** 删掉整个 partition 目录。失败必须抛出去：调用方据此决定要不要删登记，不能报出假的清理成功。 */
export async function removePartitionDir(partitionsDir: string, partition: string): Promise<void> {
  await rm(path.join(partitionsDir, partitionDirName(partition)), {
    recursive: true,
    force: true,
  });
}

export class ProfileStore {
  private readonly active = new Map<string, number>();
  // 进行中的 create：clearProfile / prune 的占用检查要看得见它们，否则会把新 session 脚下的分区清掉
  private readonly pending = new Map<string, number>();
  // 同名 profile 的关键段串行链。全 daemon 一份：各 lease 的 SessionManager 共用同一个 store，
  // 跨 lease 并发清理/创建同名 profile 也必须互斥。
  private readonly locks = new Map<string, Promise<void>>();
  private data: ProfileFile = { version: 1, profiles: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly maxProfiles = MAX_PROFILES,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: Partial<ProfileFile>;
    try {
      parsed = JSON.parse(raw) as Partial<ProfileFile>;
    } catch (error) {
      // 登记文件坏了不能当「没有 profile」启动：分区目录还在，带着一份空登记跑起来会四处对不上
      throw new Error(
        `profile 登记文件损坏：${this.file}（${(error as Error).message}）。` +
          `请把它改名备份后重启；对应的分区目录在 ${path.dirname(path.dirname(this.file))}/chromium/Partitions/ 下不受影响`,
      );
    }
    const profiles = parsed.profiles ?? {};
    for (const [name, record] of Object.entries(profiles)) {
      if (!NAME_PATTERN.test(name)) continue;
      const createdAt = typeof record.created_at === "string" ? record.created_at : new Date().toISOString();
      this.data.profiles[name] = {
        created_at: createdAt,
        last_used_at: typeof record.last_used_at === "string" ? record.last_used_at : createdAt,
        sessions: Number.isInteger(record.sessions) ? Number(record.sessions) : 0,
      };
    }
  }

  async list(): Promise<MaloProfile[]> {
    await this.load();
    return Object.keys(this.data.profiles)
      .sort()
      .map((name) => this.toProfile(name));
  }

  async exists(name: string): Promise<boolean> {
    await this.load();
    return this.data.profiles[name] !== undefined;
  }

  lastUsedAtMs(name: string): number | undefined {
    const record = this.data.profiles[name];
    if (!record) return undefined;
    const parsed = Date.parse(record.last_used_at);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  async touch(name: string): Promise<MaloProfile> {
    await this.load();
    const existing = this.data.profiles[name];
    if (!existing && Object.keys(this.data.profiles).length >= this.maxProfiles) {
      throw new DemoError("E_RESOURCE_LIMIT", `profile 数量已达上限 ${this.maxProfiles}`);
    }
    const now = new Date().toISOString();
    const record = existing ?? { created_at: now, last_used_at: now, sessions: 0 };
    record.last_used_at = now;
    record.sessions += 1;
    this.data.profiles[name] = record;
    await this.persist();
    this.registerActive(name);
    return this.toProfile(name);
  }

  async remove(name: string): Promise<boolean> {
    await this.load();
    if (!this.data.profiles[name]) return false;
    delete this.data.profiles[name];
    await this.persist();
    return true;
  }

  /** 超过 minIdleDays 没用过、且此刻没人用的 profile。只算不删，删不删由调用方决定。 */
  idleProfiles(minIdleDays: number, nowMs = Date.now()): string[] {
    const cutoff = nowMs - minIdleDays * 86_400_000;
    return Object.keys(this.data.profiles)
      .sort()
      .filter((name) => {
        const lastUsed = this.lastUsedAtMs(name);
        return (
          lastUsed !== undefined &&
          lastUsed <= cutoff &&
          this.active.get(name) === undefined &&
          this.pending.get(name) === undefined
        );
      });
  }

  registerActive(name: string): void {
    this.active.set(name, (this.active.get(name) ?? 0) + 1);
  }

  releaseActive(name: string): void {
    const next = (this.active.get(name) ?? 0) - 1;
    if (next > 0) this.active.set(name, next);
    else this.active.delete(name);
  }

  activeCount(name: string): number {
    return this.active.get(name) ?? 0;
  }

  addPending(name: string): void {
    this.pending.set(name, (this.pending.get(name) ?? 0) + 1);
  }

  releasePending(name: string): void {
    const next = (this.pending.get(name) ?? 0) - 1;
    if (next > 0) this.pending.set(name, next);
    else this.pending.delete(name);
  }

  /** 活跃会话数 + 进行中的创建数：占用检查统一看这个。 */
  inUseCount(name: string): number {
    return this.activeCount(name) + (this.pending.get(name) ?? 0);
  }

  /** 同名 profile 的关键段串行执行；前一段无论成败，后一段都接着跑。 */
  async withProfileLock<T>(name: string, critical: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(name) ?? Promise.resolve();
    const result = previous.then(critical);
    this.locks.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private toProfile(name: string): MaloProfile {
    const record = this.data.profiles[name];
    return {
      name,
      created_at: record.created_at,
      last_used_at: record.last_used_at,
      sessions: record.sessions,
      active_sessions: this.activeCount(name),
    };
  }

  private persist(): Promise<void> {
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    // A failed write must not poison the chain: the caller of that write still
    // sees the rejection, and the next write starts from a settled chain.
    this.writeChain = this.writeChain.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, payload, { mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writeChain;
  }
}
