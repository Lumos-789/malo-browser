import type { DemoError } from "../../shared/errors";
import type {
  MaloLightObservation,
  MaloNavigationDiagnostics,
  MaloNetworkInfo,
  MaloObservation,
  MaloPopupInfo,
  MaloWatchResult,
} from "../../shared/malo";
import type { ElectronPageDriver } from "../electron-page-driver";
import type { StageWindow } from "../windows/stage-window";
import type { BrowserSession } from "./browser-session";
import {
  HUMAN_BLOCK_MESSAGES,
  humanBlock,
  type AgentBlock,
  type HumanSignal,
  type HumanState,
} from "./human-signals";
import type { NetworkCapture } from "./network-capture";

export type BrowserSessionOptions = {
  leaseId: string;
  sessionId?: string;
  name?: string;
  profile?: string;
  width?: number;
  height?: number;
  rootDir: string;
  partitionsDir?: string;
  eventLimit?: number;
  /** 页面在会话之外被销毁（例如经 CDP 调试口关掉页面目标）时回调，由管理方收尾。 */
  onPageLost?: (session: BrowserSession) => void;
  /** daemon 是否以 --allow-focus 启动；只有那时 watch/login 的 focus=true 才被接受。 */
  allowFocus?: boolean;
  /**
   * 页面调 window.open 时怎么办。deny（默认）拦下并在动作结果里带回目标地址；
   * adopt 把目标地址在同一个页面打开，适合「点开新窗口的链接」这类流程。
   */
  popup?: "deny" | "adopt";
  /** 放开的页面权限（见 GRANTABLE_PERMISSIONS）；不点名的默认拒绝。 */
  permissions?: string[];
};

/**
 * 会话核心暴露给各功能模块（导航、观察、动作、登录）的那一部分。
 * BrowserSession 满足这个形状；模块只拿它当参数，不依赖 BrowserSession 本身。
 */
export type SessionInternals = {
  readonly options: BrowserSessionOptions;
  readonly profile: string | null;
  readonly stage: StageWindow;
  readonly driver: ElectronPageDriver;
  readonly capture: NetworkCapture;
  readonly human: HumanState;
  readonly failedRequests: MaloNetworkInfo["failures"];
  readonly consoleErrors: MaloNetworkInfo["console_errors"];
  navigationState: MaloNavigationDiagnostics | null;
  closed: boolean;
  /** 最近一次被拦下的 window.open（按序号判断某个动作期间有没有触发）。 */
  readonly popupSeq: number;
  lastPopup: MaloPopupInfo | null;
  record(type: string, detail?: Record<string, unknown>): void;
  assertOpen(): void;
  touch(): void;
  captureFailure(): Promise<string | null>;
  running<T>(op: () => Promise<T>): Promise<T>;
  closedWhileRunning(): DemoError;
  assertFocusAllowed(focus: boolean): void;
  watch(input?: {
    show?: boolean;
    focus?: boolean;
    width?: number;
    height?: number;
  }): Promise<MaloWatchResult>;
  /** 取走人点过的「完成」信号（登录交接用）；没有就返回 false。 */
  takeHumanDone(): boolean;
  /** 等人在面板上点「完成」，取走这个信号；超时抛 E_STEP_TIMEOUT。 */
  waitHumanDone(timeoutMs: number): Promise<void>;
};

export type { AgentBlock, HUMAN_BLOCK_MESSAGES, humanBlock, HumanSignal, HumanState };

export type WatchInput = {
  show?: boolean;
  focus?: boolean;
  width?: number;
  height?: number;
};
