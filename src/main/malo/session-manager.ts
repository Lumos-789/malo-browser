import { session as electronSession } from "electron";
import { DemoError, isDemoError } from "../../shared/errors";
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
  removePartitionDir,
  type ProfileStore,
  validateProfileName,
} from "./profile-store";
import type { SessionBudget } from "./session-budget";

const PAGE_LOST_REASON = "页面被外部关闭（例如经 CDP 调试口关掉了页面目标）";

export type ProfilePruneResult = {
  min_idle_days: number;
  apply: boolean;
  /** 超过 min_idle_days 没用、且此刻没人在用的 profile。 */
  candidates: string[];
  /** apply=true 时真正删掉的 profile（候选里被并发占用的会跳过）。 */
  removed: string[];
};

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private creating = 0;
  // 不是被调用方关掉、而是自己结束的会话（页面被外部销毁）：留一条原因，
  // 之后再来访问时说清楚它为什么不在了，而不是笼统的「不存在」。
  private readonly endedReasons = new Map<string, string>();
  private readonly endedReasonLimit = 100;

  constructor(
    private readonly options: {
      leaseId: string;
      rootDir: string;
      maxSessions: number;
      profiles: ProfileStore;
      partitionsDir?: string;
      /** daemon 全局会话名额，各 lease 的 SessionManager 共用一份。 */
      budget?: SessionBudget;
      /** daemon 是否以 --allow-focus 启动；只有那时 watch/login 的 focus=true 才被接受。 */
      allowFocus?: boolean;
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
    /** 这个会话对 window.open 的处理方式，见 BrowserSessionOptions.popup。 */
    popup?: "deny" | "adopt";
    /** 放开的页面权限，见 GRANTABLE_PERMISSIONS。 */
    permissions?: string[];
  }): Promise<MaloSessionCreated> {
    if (this.sessions.size + this.creating >= this.options.maxSessions) {
      throw new DemoError(
        "E_RESOURCE_LIMIT",
        `lease ${this.options.leaseId} 已达到 session 上限 ${this.options.maxSessions}`,
      );
    }
    const profile = input.profile === undefined ? undefined : validateProfileName(input.profile);
    this.options.budget?.reserve();
    let kept = false;
    this.creating += 1;
    let profileReserved = false;
    const profiles = this.options.profiles;
    try {
      if (profile !== undefined) {
        await profiles.withProfileLock(profile, async () => {
          profiles.addPending(profile);
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
        allowFocus: this.options.allowFocus === true,
        popup: input.popup,
        permissions: input.permissions,
        onPageLost: (lost) => this.losePage(lost),
      });
      if (session.isPageLost()) {
        await session.close();
        throw new DemoError("E_SESSION_NOT_FOUND", `session 创建期间页面被销毁：${session.id}`);
      }
      this.sessions.set(session.id, session);
      if (profile !== undefined) {
        try {
          await profiles.touch(profile);
        } catch (error) {
          this.sessions.delete(session.id);
          await session.close();
          throw error;
        }
      }
      kept = true;
      return {
        ...session.summary(),
        session_token: session.token,
        downloads_dir: session.downloadsDir,
        artifacts_dir: session.artifactsDir,
        events_log: session.eventsLog,
      };
    } finally {
      this.creating -= 1;
      if (!kept) this.options.budget?.release();
      // 成功路径上 touch 已把占用转交给 activeCount，失败路径上没有 touch；
      // 两条路径都要在锁内撤销 pending 登记，clearProfile 才不会对着已放弃的 create 空拒。
      if (profileReserved && profile !== undefined) {
        const name = profile;
        await profiles.withProfileLock(name, async () => {
          profiles.releasePending(name);
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
    if (!session || session.isClosed()) throw this.missing(id);
    return session;
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw this.missing(id);
    this.sessions.delete(id);
    await this.closeSession(session);
  }

  async reapIdle(idleMs: number, now = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const [id, session] of this.sessions) {
      // 有操作在进行、或窗口正显示给人看：不算空闲，不回收
      if (session.idleMs(now) < idleMs || session.isPinned()) continue;
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
    return this.options.profiles.withProfileLock(name, async () => {
      const inUse = this.options.profiles.inUseCount(name);
      if (inUse > 0) {
        throw new DemoError(
          "E_PROFILE_LOCKED",
          `profile ${name} 仍有 ${inUse} 个 session 在使用，先关闭这些 session 再清理`,
        );
      }
      const partitionSession = electronSession.fromPartition(profilePartition(name));
      await partitionSession.clearStorageData();
      await partitionSession.clearCache();
      if (this.options.partitionsDir !== undefined) {
        try {
          await removePartitionDir(this.options.partitionsDir, profilePartition(name));
        } catch (error) {
          // 目录没删掉就不删登记：否则留下一个有登录态数据、却没人认领的孤儿分区
          throw new DemoError(
            "E_PROFILE_CLEAR_FAILED",
            `profile ${name} 的分区目录没有删干净：${(error as Error).message}`,
            { details: { profile: name } },
          );
        }
      }
      const existed = await this.options.profiles.remove(name);
      return { profile: name, existed };
    });
  }

  /** 找出（并可选地删掉）长期没用且没人在用的 profile。默认只预览，apply=true 才真删。 */
  async pruneProfiles(minIdleDays: number, apply: boolean): Promise<ProfilePruneResult> {
    if (!Number.isFinite(minIdleDays) || minIdleDays < 0) {
      throw new DemoError("E_BAD_REQUEST", "min_idle_days 必须是非负数");
    }
    const candidates = this.options.profiles.idleProfiles(minIdleDays);
    const removed: string[] = [];
    if (apply) {
      for (const name of candidates) {
        try {
          await this.clearProfile(name);
          removed.push(name);
        } catch (error) {
          // 预览和执行之间被人占了：跳过它，其余照删
          if (isDemoError(error) && error.code === "E_PROFILE_LOCKED") continue;
          throw error;
        }
      }
    }
    return { min_idle_days: minIdleDays, apply, candidates, removed };
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
      this.options.budget?.release();
    }
  }

  /** 页面在会话之外被销毁：会话已不可用，就地收尾并归还名额，不让它占着窗口和名额等回收。 */
  private losePage(session: BrowserSession): void {
    this.rememberEnded(session.id, PAGE_LOST_REASON);
    // 还在创建流程里的会话由 create 自己收尾（它管着名额的归还）
    if (!this.sessions.delete(session.id)) return;
    void this.closeSession(session).catch((error) => {
      console.error(`[malo] 页面失效后清理 session ${session.id} 失败：${(error as Error).message}`);
    });
  }

  private rememberEnded(id: string, reason: string): void {
    this.endedReasons.delete(id);
    this.endedReasons.set(id, reason);
    if (this.endedReasons.size > this.endedReasonLimit) {
      this.endedReasons.delete(this.endedReasons.keys().next().value as string);
    }
  }

  private missing(id: string): DemoError {
    const reason = this.endedReasons.get(id);
    return new DemoError(
      "E_SESSION_NOT_FOUND",
      reason ? `session 已结束：${reason}（${id}）` : `session 不存在：${id}`,
    );
  }
}
