export type MaloLease = {
  lease_id: string;
  agent_id: string;
  endpoint: string;
  token: string;
  expires_at: string;
};

export type MaloSessionSummary = {
  session_id: string;
  name: string;
  profile: string | null;
  url: string;
  title: string;
  created_at: string;
  last_used_at: string;
};

export type MaloSessionCreated = MaloSessionSummary & {
  session_token: string;
  downloads_dir: string;
  artifacts_dir: string;
};

export type MaloProfile = {
  name: string;
  created_at: string;
  last_used_at: string;
  sessions: number;
  active_sessions: number;
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
    rect: { x: number; y: number; width: number; height: number };
  }>;
  frames: Array<{ url: string; name: string; title: string }>;
  dialogs: Array<{ text: string; selector: string }>;
  messages: Array<{ text: string; selector: string }>;
  truncated: Record<string, boolean>;
};

export type MaloExtractResult = {
  selector: string;
  mode: "text" | "html" | "attributes";
  count: number;
  matches: Array<{
    selector: string;
    tag: string;
    text?: string;
    html?: string;
    attributes?: Record<string, string>;
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

export type MaloAssertInput = {
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
  reason: string;
  profile: string | null;
  final_url: string;
  title: string;
  credentials_used: boolean;
  watch?: MaloWatchResult;
  attempts: number;
  observation: MaloLightObservation;
};

export type MaloClickAction = {
  type: "click";
  selector?: string;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  click_count?: number;
};

export type MaloFillAction = {
  type: "fill";
  selector: string;
  text: string;
  clear?: boolean;
};

export type MaloPressAction = {
  type: "press";
  key: string;
  modifiers?: number;
};

export type MaloScrollAction = {
  type: "scroll";
  dx?: number;
  dy?: number;
};

export type MaloHoverAction = {
  type: "hover";
  selector?: string;
  x?: number;
  y?: number;
};

export type MaloSelectAction = {
  type: "select";
  selector: string;
  value?: string;
  label?: string;
};

export type MaloFocusAction = {
  type: "focus";
  selector: string;
};

export type MaloHistoryAction = {
  type: "history";
  action: "back" | "forward" | "reload";
};

export type MaloScrollIntoViewAction = {
  type: "scroll_into_view";
  selector: string;
};

export type MaloWaitAction = {
  type: "wait_for";
  selector?: string;
  text?: string;
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
  | MaloPressAction
  | MaloScrollAction
  | MaloHoverAction
  | MaloSelectAction
  | MaloFocusAction
  | MaloHistoryAction
  | MaloScrollIntoViewAction
  | MaloWaitAction
  | MaloSleepAction;

export type MaloActionResult = {
  action: MaloAction["type"];
  detail: string;
  observation: MaloLightObservation;
};

export type MaloSessionEvent = {
  seq: number;
  at: string;
  type: string;
  detail?: Record<string, unknown>;
};
