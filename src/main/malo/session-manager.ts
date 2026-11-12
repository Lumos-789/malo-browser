import { session as electronSession } from "electron";
import { DemoError } from "../../shared/errors";
import type {
  MaloProfile,
  MaloProfileImportInput,
  MaloProfileImportResult,
  MaloSessionCreated,
} from "../../shared/malo";
import { BrowserSession } from "./browser-session";
import { importLoginState } from "./login-import";
import {
  profilePartition,
  type ProfileStore,
  removePartitionDir,
  validateProfileName,
} from "./profile-store";

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private creating = 0;
  // clearProfile 与带 profile 的 create 按 profile 名串行的关键段；锁的 entry
  // 是已吞掉结果的上一个关键段，串行链空闲时留在 Map 里（键数受 profile 名约束）。
  private readonly profileLocks = new Map<string, Promise<void>>();
  // 已登记占用、但还没跑完 BrowserSession.create 的 profile：clearProfile 的
  // 占用检查必须看得见这些并发 create，否则会把新 session 脚下的分区清掉。
  private readonly creatingProfiles = new Map<string, number>();

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
    let profileReserved = false;
    try {
      if (profile !== undefined) {
        await this.withProfileLock(profile, async () => {
          this.bumpCreatingProfiles(profile, 1);
          profileReserved = true;
        });
      }
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
      // 成功路径上 touch 已把占用转交给 activeCount，失败路径上没有 touch；
      // 两条路径都要在锁内撤销 pending 登记，clearProfile 才不会对着已放弃的 create 空拒。
      if (profileReserved && profile !== undefined) {
        const name = profile;
        await this.withProfileLock(name, async () => {
          this.bumpCreatingProfiles(name, -1);
        });
      }
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
    return this.withProfileLock(name, async () => {
      const active =
        this.options.profiles.activeCount(name) + (this.creatingProfiles.get(name) ?? 0);
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
    });
  }

  async importProfileLogin(
    rawName: string,
    input: MaloProfileImportInput,
  ): Promise<MaloProfileImportResult> {
    const name = validateProfileName(rawName);
    const partitionSession = electronSession.fromPartition(profilePartition(name));
    const result = await importLoginState(partitionSession, input);
    const created = !(await this.options.profiles.exists(name));
    await this.options.profiles.touch(name);
    return { profile: name, created, ...result };
  }

  private async closeSession(session: BrowserSession): Promise<void> {
    try {
      await session.close();
    } finally {
      if (session.profile !== null) this.options.profiles.releaseActive(session.profile);
    }
  }

  /** 同名 profile 的关键段串行执行；前一段无论成败，后一段都接着跑。 */
  private withProfileLock<T>(name: string, critical: () => Promise<T>): Promise<T> {
    const previous = this.profileLocks.get(name) ?? Promise.resolve();
    const result = previous.then(critical);
    this.profileLocks.set(
      name,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  private bumpCreatingProfiles(name: string, delta: 1 | -1): void {
    const next = (this.creatingProfiles.get(name) ?? 0) + delta;
    if (next > 0) this.creatingProfiles.set(name, next);
    else this.creatingProfiles.delete(name);
  }
}
