import { session as electronSession } from "electron";
import { DemoError } from "../../shared/errors";
import type { MaloProfile, MaloSessionCreated } from "../../shared/malo";
import { BrowserSession } from "./browser-session";
import {
  profilePartition,
  type ProfileStore,
  removePartitionDir,
  validateProfileName,
} from "./profile-store";

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private creating = 0;

  constructor(
    private readonly options: {
      leaseId: string;
      rootDir: string;
      maxSessions: number;
      profiles: ProfileStore;
      partitionsDir?: string;
    },
  ) {
    if (!Number.isInteger(options.maxSessions) || options.maxSessions <= 0) {
      throw new Error(`maxSessions 必须是正整数：${options.maxSessions}`);
    }
  }

  async create(input: {
    name?: string;
    width?: number;
    height?: number;
    profile?: string;
  }): Promise<MaloSessionCreated> {
    if (this.sessions.size + this.creating >= this.options.maxSessions) {
      throw new DemoError(
        "E_RESOURCE_LIMIT",
        `lease ${this.options.leaseId} 已达到 session 上限 ${this.options.maxSessions}`,
      );
    }
    const profile = input.profile === undefined ? undefined : validateProfileName(input.profile);
    this.creating += 1;
    try {
      const session = await BrowserSession.create({
        leaseId: this.options.leaseId,
        name: input.name,
        width: input.width,
        height: input.height,
        profile,
        rootDir: this.options.rootDir,
        partitionsDir: this.options.partitionsDir,
      });
      this.sessions.set(session.id, session);
      if (profile !== undefined) {
        try {
          await this.options.profiles.touch(profile);
        } catch (error) {
          this.sessions.delete(session.id);
          await session.close();
          throw error;
        }
      }
      return {
        ...session.summary(),
        session_token: session.token,
        downloads_dir: session.downloadsDir,
        artifacts_dir: session.artifactsDir,
      };
    } finally {
      this.creating -= 1;
    }
  }

  list() {
    return [...this.sessions.values()]
      .filter((session) => !session.isClosed())
      .map((session) => session.summary());
  }

  get(id: string): BrowserSession {
    const session = this.sessions.get(id);
    if (!session || session.isClosed()) {
      throw new DemoError("E_SESSION_NOT_FOUND", `session 不存在：${id}`);
    }
    return session;
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new DemoError("E_SESSION_NOT_FOUND", `session 不存在：${id}`);
    this.sessions.delete(id);
    await this.closeSession(session);
  }

  async reapIdle(idleMs: number, now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.idleMs(now) < idleMs) continue;
      this.sessions.delete(id);
      try {
        await this.closeSession(session);
        removed.push(id);
      } catch (error) {
        console.error(`[malo] 回收空闲 session ${id} 失败：${(error as Error).message}`);
      }
    }
    return removed;
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.closeSession(session)));
  }

  async listProfiles(): Promise<MaloProfile[]> {
    return this.options.profiles.list();
  }

  async clearProfile(rawName: string): Promise<{ profile: string; existed: boolean }> {
    const name = validateProfileName(rawName);
    const active = this.options.profiles.activeCount(name);
    if (active > 0) {
      throw new DemoError(
        "E_PROFILE_LOCKED",
        `profile ${name} 仍有 ${active} 个 session 在使用，先关闭这些 session 再清理`,
      );
    }
    const partitionSession = electronSession.fromPartition(profilePartition(name));
    await partitionSession.clearStorageData();
    await partitionSession.clearCache();
    if (this.options.partitionsDir !== undefined) {
      await removePartitionDir(this.options.partitionsDir, profilePartition(name));
    }
    const existed = await this.options.profiles.remove(name);
    return { profile: name, existed };
  }

  private async closeSession(session: BrowserSession): Promise<void> {
    try {
      await session.close();
    } finally {
      if (session.profile !== null) this.options.profiles.releaseActive(session.profile);
    }
  }
}
