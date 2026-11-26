import { DemoError } from "../../shared/errors";
import type {
  MaloLightObservation,
  MaloLoginInput,
  MaloLoginResult,
  MaloWatchResult,
} from "../../shared/malo";
import { sleep } from "../tools";
import { executeAction } from "./actions/run-action";
import { observePage } from "./observation";
import type { SessionInternals } from "./session-internals";
import { withTimeout } from "./timeouts";

export async function runLogin(session: SessionInternals, input: MaloLoginInput): Promise<MaloLoginResult> {
  session.assertOpen();
  session.touch();
  const requestedMode = input.mode ?? "auto";
  if (requestedMode !== "auto" && requestedMode !== "password" && requestedMode !== "watch") {
    throw new DemoError("E_BAD_REQUEST", "login.mode 只能是 auto / password / watch");
  }
  const hasCredentials =
    typeof input.username === "string" &&
    input.username !== "" &&
    typeof input.password === "string" &&
    input.password !== "";
  for (const field of [
    "username",
    "password",
    "username_selector",
    "password_selector",
    "submit_selector",
    "success_url_contains",
    "success_selector",
    "error_selector",
  ] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      throw new DemoError("E_BAD_REQUEST", `login.${field} 必须是字符串`);
    }
  }
  const mode = requestedMode === "auto" ? (hasCredentials ? "password" : "watch") : requestedMode;
  if (mode === "password" && !hasCredentials) {
    throw new DemoError("E_BAD_REQUEST", "password 模式需要 username 和 password");
  }
  session.assertFocusAllowed(input.focus === true);
  const rawTimeout = Number(input.timeout_ms ?? (mode === "watch" ? 180_000 : 30_000));
  if (!Number.isFinite(rawTimeout) || rawTimeout < 1_000 || rawTimeout > 600_000) {
    throw new DemoError("E_BAD_REQUEST", "login.timeout_ms 必须是 1000-600000 的毫秒数");
  }
  const timeoutMs = Math.floor(Math.max(1_000, Math.min(600_000, rawTimeout)));
  const initialUrl = session.stage.view.webContents.getURL();
  session.record("login.started", {
    mode,
    profile: session.profile,
    has_username: typeof input.username === "string" && input.username !== "",
    has_password: typeof input.password === "string" && input.password !== "",
  });

  let watchResult: MaloWatchResult | undefined;
  if (mode === "watch") {
    watchResult = await session.watch({ show: true, focus: input.focus === true });
  }

  let attempts = 0;
  let waitReason = "timeout";
  try {
    if (mode === "password") {
      const fields = await findLoginFields(session, input);
      if (fields.username === "" || fields.password === "") {
        waitReason = "login_fields_not_found";
      } else {
        await executeAction(session, 
          { type: "fill", selector: fields.username, text: input.username! },
          10_000,
        );
        await executeAction(session, 
          { type: "fill", selector: fields.password, text: input.password! },
          10_000,
        );
        if (fields.submit === "") {
          waitReason = "submit_button_not_found";
        } else {
          await executeAction(session, { type: "click", selector: fields.submit }, 10_000);
        }
      }
    }
    if (waitReason !== "login_fields_not_found" && waitReason !== "submit_button_not_found") {
      const waited = await waitForLogin(session, input, initialUrl, timeoutMs);
      attempts = waited.attempts;
      waitReason = waited.reason;
    }
  } catch (error) {
    waitReason = error instanceof Error ? error.message : String(error);
    session.record("login.action_error", { reason: waitReason });
  }

  const ok = waitReason === "success" || waitReason === "human_done";
  const observation = await observePage(session, "light", 2_000).catch(() => fallbackObservation(session));
  if (watchResult) {
    if (!ok && input.keep_visible !== true) {
      // Keep a timed-out window visible so the human can continue; hide only after success.
    } else if (ok && input.keep_visible !== true) {
      session.stage.hide();
      watchResult = { ...watchResult, visible: false, window: "hidden" };
    }
  }
  session.record("login.finished", {
    mode,
    ok,
    reason: waitReason,
    final_url: observation.url,
  });
  return {
    mode,
    ok,
    reason: waitReason,
    profile: session.profile,
    final_url: observation.url,
    title: observation.title,
    credentials_used: mode === "password",
    watch: watchResult,
    attempts,
    observation,
  };
}

export async function findLoginFields(
  session: SessionInternals,
  input: MaloLoginInput,
): Promise<{ username: string; password: string; submit: string }> {
  return session.driver.evaluate(`(() => {
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const selectorFor = (el) => {
      if (el.getAttribute("data-demo-id")) return '[data-demo-id="' + CSS.escape(el.getAttribute("data-demo-id")) + '"]';
      if (el.id) return "#" + CSS.escape(el.id);
      const name = el.getAttribute("name");
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      const autocomplete = el.getAttribute("autocomplete");
      if (autocomplete) return el.tagName.toLowerCase() + '[autocomplete="' + CSS.escape(autocomplete) + '"]';
      return el.tagName.toLowerCase();
    };
    const pick = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && visible(el)) return selectorFor(el);
      }
      return "";
    };
    const username = ${JSON.stringify(input.username_selector ?? "")} || pick([
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name*="user" i]',
      'input[name*="account" i]',
      'input[name*="login" i]',
      'input[id*="user" i]',
      'input[id*="account" i]',
      'input[type="text"]'
    ]);
    const password = ${JSON.stringify(input.password_selector ?? "")} || pick(['input[type="password"]']);
    const buttons = Array.from(document.querySelectorAll('button,input[type="submit"],[role="button"]'))
      .filter(visible);
    const named = buttons.find((el) => /登录|登入|sign in|log in|submit/i.test(el.innerText || el.value || ""));
    const submit = ${JSON.stringify(input.submit_selector ?? "")} || (named ? selectorFor(named) : (buttons[0] ? selectorFor(buttons[0]) : ""));
    return { username, password, submit };
  })()`);
}

export async function waitForLogin(
  session: SessionInternals,
  input: MaloLoginInput,
  initialUrl: string,
  timeoutMs: number,
): Promise<{ attempts: number; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    session.assertOpen();
    attempts += 1;
    // 人说做完了就是做完了：扫码、验证码、短信这些页面没法自己判定的登录，由人给结论
    if (session.takeHumanDone()) return { attempts, reason: "human_done" };
    const state = await withTimeout(
      session.driver.evaluate<{
        url: string;
        has_password: boolean;
        success: boolean;
        error_selector: boolean;
        error_text: string;
        text: string;
      }>(`(() => {
        const text = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 4000);
        return {
          url: location.href,
          has_password: !!document.querySelector('input[type="password"]'),
          success: ${input.success_selector ? `!!document.querySelector(${JSON.stringify(input.success_selector)})` : "false"},
          error_selector: ${input.error_selector ? `!!document.querySelector(${JSON.stringify(input.error_selector)})` : "false"},
          error_text: (text.match(/密码错误|账号或密码|登录失败|验证码错误|请输入验证码|滑动验证|安全验证|Incorrect|Invalid credentials|Wrong password/i) || [""])[0],
          text
        };
      })()`),
      800,
      "登录状态采样超时",
    ).catch(() => null);
    if (state) {
      if (state.error_selector || state.error_text) {
        return { attempts, reason: "login_error" };
      }
      if (input.success_selector) {
        if (state.success) return { attempts, reason: "success" };
      } else if (input.success_url_contains) {
        if (state.url.includes(input.success_url_contains)) return { attempts, reason: "success" };
      } else if (
        !state.has_password &&
        (state.url !== initialUrl || /退出登录|退出|sign out|log out|dashboard|我的账号/i.test(state.text))
      ) {
        return { attempts, reason: "success" };
      }
    }
    await sleep(250);
  }
  return { attempts, reason: "timeout" };
}

export function fallbackObservation(session: SessionInternals): MaloLightObservation {
  const wc = session.stage.view.webContents;
  const alive = wc !== undefined && !wc.isDestroyed();
  return {
    url: alive ? wc.getURL() : "",
    title: alive ? wc.getTitle() : "",
    ready_state: "loading",
    loading: true,
    viewport: { width: 0, height: 0, dpr: 1 },
    dom: { elements: 0, interactive: 0, text_length: 0 },
    body_text: "",
  };
}
