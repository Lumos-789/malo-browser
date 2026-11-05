import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DemoError } from "../../shared/errors";
import type { MaloProfile } from "../../shared/malo";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_PROFILES = 64;

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

export async function removePartitionDir(partitionsDir: string, partition: string): Promise<void> {
  try {
    await rm(path.join(partitionsDir, partitionDirName(partition)), { recursive: true, force: true });
  } catch (error) {
    console.error(`[malo] 清理 partition 目录失败：${(error as Error).message}`);
  }
}

export class ProfileStore {
  private readonly active = new Map<string, number>();
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
    const parsed = JSON.parse(raw) as Partial<ProfileFile>;
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
