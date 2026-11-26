export type MaloLease = {
  lease_id: string;
  agent_id: string;
  endpoint: string;
  token: string;
  expires_at: string;
  /** 握手信息：客户端据此判断能力，不用等调用失败。 */
  version: string;
  features: string[];
  ttl_seconds: number;
};

export type MaloSessionSummary = {
  session_id: string;
  name: string;
  profile: string | null;
  url: string;
  title: string;
  created_at: string;
  last_used_at: string;
  /** 窗口此刻是否显示在屏幕上（watch / 登录接管打开的）。 */
  visible: boolean;
  /** 人在面板上发过的信号：done 等 agent 来取；paused / stopped 期间 agent 不能操作页面。 */
  human?: { done: boolean; paused: boolean; stopped: boolean };
  /** 这个会话放开的页面权限。 */
  permissions?: string[];
};

export type MaloSessionCreated = MaloSessionSummary & {
  session_token: string;
  downloads_dir: string;
  artifacts_dir: string;
  /** 会话事件的落盘文件（JSONL，每行一条），会话关闭后仍在，供事后审计。 */
  events_log: string;
};

export type MaloProfile = {
  name: string;
  created_at: string;
  last_used_at: string;
  sessions: number;
  active_sessions: number;
};

export type MaloProfileImportInput = {
  cdp_url: string;
  /** 必填：只导入这些域（及其子域）的 cookie。不限定就等于搬走源浏览器的全部登录态。 */
  domains: string[];
  session_cookie_ttl_days?: number;
};

export type MaloProfileImportResult = {
  profile: string;
  created: boolean;
  source: string;
  cookies_total: number;
  cookies_matched: number;
  cookies_written: number;
  cookies_failed: number;
  failed: Array<{ name: string; domain: string; error: string }>;
};

export type MaloNavigationDiagnostics = {
  requested_url: string;
  final_url: string;
  http_status: number | null;
  http_status_text: string;
  load_state: "complete" | "partial" | "timeout" | "failed";
  net_error: number | null;
  net_error_description: string | null;
  navigations: number;
  redirects: Array<{ url: string; status: number | null }>;
  started_at: string;
  finished_at: string | null;
  settle: {
    waited_ms: number;
    ready_state: string;
    dom_elements: number;
    stable_samples: number;
  };
};

export type MaloRuntimeInfo = {
  user_agent: string;
  webdriver: boolean;
  online: boolean;
  visibility_state: string;
  hardware_concurrency: number;
};

export type MaloNetworkInfo = {
  failed_requests: number;
  failures: Array<{ url: string; error: string; resource_type: string }>;
  console_errors: Array<{ message: string; source: string; line: number }>;
};

/**
 * Why a response record has no body. `too_large` is reserved by the contract:
 * bodies over the cap are truncated instead, so the daemon never emits it.
 * `getResponseBody_failed` carries the CDP reason after the colon.
 */
export type MaloResponseBodyError =
  | "not_subscribed"
  | "no_body"
  | "too_large"
  | "evicted"
  | "pending"
  | "binary"
  | `getResponseBody_failed: ${string}`;

export type MaloResponseRecord = {
  seq: number;
  url: string;
  status: number;
  mime_type: string;
  resource_type: string;
  body: string | null;
  body_truncated: boolean;
  body_error: MaloResponseBodyError | null;
};

export type MaloNetworkCaptureState = {
  url_prefixes: string[];
  captured: number;
};

export type MaloResponsesResult = {
  responses: MaloResponseRecord[];
  has_more: boolean;
};

export type MaloLightObservation = {
  url: string;
  title: string;
  ready_state: string;
  loading: boolean;
  viewport: { width: number; height: number; dpr: number };
  dom: {
    elements: number;
    interactive: number;
    text_length: number;
  };
  body_text: string;
  navigation?: MaloNavigationDiagnostics;
  runtime?: MaloRuntimeInfo;
  network?: MaloNetworkInfo;
};

export type MaloObservation = MaloLightObservation & {
  screenshot?: {
    mime_type: "image/png";
    base64: string;
  };
  /** 只在使用 clip_selector 时出现：实际裁剪到的文档坐标矩形 */
  screenshot_clip?: {
    selector?: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type MaloSnapshotFrame = {
  /** snapshot.frames 的下标，动作的 frame 参数用它指定这个 iframe。 */
  index: number;
  /** 父框架的下标；null = 直接挂在顶层页面上。 */
  parent: number | null;
  url: string;
  name: string;
  /** iframe 的内容框在顶层视口里的位置与大小。 */
  rect: { left: number; top: number; width: number; height: number };
  /** 这个 iframe 里的页面内容（在深度与数量上限内才有）。 */
  content?: MaloSnapshot;
  /** 内容读不出来时的原因，不影响其余部分。 */
  content_error?: string;
};

export type MaloSnapshot = {
  url: string;
  title: string;
  ready_state: string;
  viewport: { width: number; height: number; dpr: number };
  scroll: { x: number; y: number; height: number };
  text: string;
  text_length: number;
  headings: Array<{ level: number; text: string; selector: string }>;
  links: Array<{ text: string; href: string; selector: string }>;
  buttons: Array<{ text: string; selector: string; disabled: boolean }>;
  inputs: Array<{
    type: string;
    name: string;
    placeholder: string;
    label: string;
    selector: string;
    value: string;
    sensitive: boolean;
  }>;
  selects: Array<{ name: string; selector: string; value: string; options: string[] }>;
  forms: Array<{ action: string; method: string; selector: string; fields: number }>;
  tables: Array<{ headers: string[]; rows: string[][]; truncated: boolean }>;
  landmarks: Array<{ role: string; label: string; selector: string }>;
  interactive: Array<{
    tag: string;
    role: string;
    text: string;
    selector: string;
    /** x/y 是元素中心（可直接喂给 click/drag），left/top 是左上角；都是视口坐标。 */
    rect: { x: number; y: number; left: number; top: number; width: number; height: number };
  }>;
  /** 靠 role 表达语义的自定义组件（tab、option、menuitem、switch 等）。 */
  widgets: Array<{
    role: string;
    tag: string;
    text: string;
    selector: string;
    disabled: boolean;
    selected: boolean;
    checked: boolean;
    expanded: boolean;
  }>;
  frames: MaloSnapshotFrame[];
  /** iframe 列表读不出来时的原因（页面正在变化）。 */
  frames_error?: string;
  /** 有 iframe 因为超出 max_frames 没读到内容。 */
  frames_truncated?: boolean;
  dialogs: Array<{ text: string; selector: string }>;
  messages: Array<{ text: string; selector: string }>;
  truncated: Record<string, boolean>;
};

export type MaloExtractResult = {
  selector: string;
  mode: "text" | "html" | "attributes" | "rect";
  /** 结果来自哪个 iframe（顶层页面时没有这个字段）。 */
  frame?: number;
  count: number;
  matches: Array<{
    selector: string;
    tag: string;
    text?: string;
    html?: string;
    attributes?: Record<string, string>;
    /** mode=rect：x/y 为中心点（可直接喂给 click/drag），left/top 为左上角 */
    rect?: { x: number; y: number; left: number; top: number; width: number; height: number };
    visible: boolean;
  }>;
  truncated: boolean;
};

export type MaloWatchResult = {
  visible: boolean;
  focused: boolean;
  url: string;
  title: string;
  window: "shown" | "hidden";
};

export type MaloAssertInput = FrameTarget & {
  visible?: string;
  hidden?: string;
  text?: string;
  selector?: string;
  value?: string;
  url?: string;
  count?: number;
  timeout_ms?: number;
};

export type MaloAssertCheck = {
  kind: "visible" | "hidden" | "text" | "value" | "url" | "count";
  expected: unknown;
  actual: unknown;
  ok: boolean;
};

export type MaloAssertResult = {
  ok: true;
  passed: true;
  checks: MaloAssertCheck[];
  url: string;
  title: string;
  waited_ms: number;
};

/**
 * A failed assertion is a business verdict, not a broken service: the HTTP
 * surface answers 200 with this payload instead of an error status.
 */
export type MaloAssertFailure = {
  ok: false;
  passed: false;
  checks: MaloAssertCheck[];
  url?: string;
  waited_ms?: number;
  screenshot?: string;
  error: { code: "E_ASSERTION_FAILED"; message: string; details: Record<string, unknown> };
};

export type MaloRunStepResult = {
  index: number;
  type: string;
  ok: boolean;
  duration_ms: number;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
};

export type MaloRunReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  step_count: number;
  failed_step: number | null;
  steps: MaloRunStepResult[];
  report_path: string;
};

export type MaloLoginInput = {
  mode?: "auto" | "password" | "watch";
  username?: string;
  password?: string;
  username_selector?: string;
  password_selector?: string;
  submit_selector?: string;
  success_url_contains?: string;
  success_selector?: string;
  error_selector?: string;
  timeout_ms?: number;
  focus?: boolean;
  keep_visible?: boolean;
};

export type MaloLoginResult = {
  mode: "password" | "watch";
  ok: boolean;
  /** success = 页面自己判定已登录；human_done = 人在面板上点了「完成」。 */
  reason: string;
  profile: string | null;
  final_url: string;
  title: string;
  credentials_used: boolean;
  watch?: MaloWatchResult;
  attempts: number;
  observation: MaloLightObservation;
};

/** frame = snapshot.frames 的下标：在这个 iframe 里操作；不给就是顶层页面。 */
export type FrameTarget = {
  frame?: number;
  /** 保险：该 iframe 的 URL 必须包含这个片段，否则说明页面变了、序号对不上。 */
  frame_url?: string;
};

export type MaloClickAction = FrameTarget & {
  type: "click";
  selector?: string;
  /** 按可见文本定位（子串匹配、取最内层可见元素）；与 selector 同给时 selector 是搜索范围 */
  text?: string;
  /** text 命中多个时取第几个（从 1 起，默认 1） */
  nth?: number;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  click_count?: number;
};

export type MaloFillAction = FrameTarget & {
  type: "fill";
  selector: string;
  text: string;
  clear?: boolean;
  /** 默认 true：回读元素值校验落地理，不落地报 E_FILL_NOT_LANDED；页面会改写输入时才关 */
  verify?: boolean;
};

export type MaloDragAction = {
  type: "drag";
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  /** 插值步数 1-100，默认 12；滑块/裁切框这类监听 pointer 序列的组件靠步进事件驱动 */
  steps?: number;
};

export type MaloUploadFileAction = {
  type: "upload_file";
  selector: string;
  files: string[];
};

export type MaloPressAction = {
  type: "press";
  key: string;
  modifiers?: number;
};

export type MaloScrollAction = FrameTarget & {
  type: "scroll";
  dx?: number;
  dy?: number;
  /** 滚轮落点（视口坐标）；不给就打在视口中心。 */
  x?: number;
  y?: number;
};

export type MaloTypeAction = {
  type: "type";
  text: string;
  /** 每个字符之间的间隔毫秒数，0-1000。 */
  delay_ms?: number;
};

export type MaloHoverAction = FrameTarget & {
  type: "hover";
  selector?: string;
  x?: number;
  y?: number;
};

export type MaloSelectAction = FrameTarget & {
  type: "select";
  selector: string;
  value?: string;
  label?: string;
};

export type MaloFocusAction = FrameTarget & {
  type: "focus";
  selector: string;
};

export type MaloHistoryAction = {
  type: "history";
  action: "back" | "forward" | "reload";
};

export type MaloScrollIntoViewAction = FrameTarget & {
  type: "scroll_into_view";
  selector: string;
};

export type MaloWaitAction = FrameTarget & {
  type: "wait_for";
  selector?: string;
  text?: string;
  /** 等人在 watch 窗口的工具条上点「完成」。 */
  human?: boolean;
  state?: "attached" | "visible" | "hidden";
  timeout_ms?: number;
};

export type MaloSleepAction = {
  type: "sleep";
  ms: number;
};

export type MaloAction =
  | MaloClickAction
  | MaloFillAction
  | MaloDragAction
  | MaloUploadFileAction
  | MaloPressAction
  | MaloScrollAction
  | MaloTypeAction
  | MaloHoverAction
  | MaloSelectAction
  | MaloFocusAction
  | MaloHistoryAction
  | MaloScrollIntoViewAction
  | MaloWaitAction
  | MaloSleepAction;

/** 这个动作触发的 window.open：被拦下时给出目标地址，adopt 模式下已在同一页面打开。 */
export type MaloPopupInfo = {
  url: string;
  adopted: boolean;
};

export type MaloActionResult = {
  action: MaloAction["type"];
  detail: string;
  observation: MaloLightObservation;
  popup?: MaloPopupInfo;
};

export type MaloEventsPage = {
  events: MaloSessionEvent[];
  /** 下一页的 after 游标。 */
  next_after: number;
  /** after 之后、最早一条留档之前丢掉的事件数（环形缓冲被覆盖）。 */
  dropped: number;
};

export type MaloSessionEvent = {
  seq: number;
  at: string;
  type: string;
  detail?: Record<string, unknown>;
};
