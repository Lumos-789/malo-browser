import { DemoError } from "../../shared/errors";
import type { MaloAssertInput, MaloAssertResult } from "../../shared/malo";
import { buildAssertChecks, describeAssertFailure, type MaloAssertState } from "./assertions";
import { resolveContext, type PageContext } from "./frames";
import { sleep } from "../tools";
import type { SessionInternals } from "./session-internals";

export async function checkExpectations(
  session: SessionInternals,
  input: MaloAssertInput,
): Promise<MaloAssertResult> {
  session.assertOpen();
  session.touch();
  const timeoutMs = Math.max(0, Math.min(120_000, Math.floor(input.timeout_ms ?? 5_000)));
  // 先解析一次目标页面上下文：iframe 序号无效、或页面正在变化时立刻失败，不进轮询
  const ctx = await resolveContext(session, input);
  const started = Date.now();
  for (;;) {
    session.assertOpen();
    const state = await readAssertState(ctx, input);
    if (state.invalid_selector !== null) {
      throw new DemoError("E_BAD_REQUEST", `assert 选择器无效：${state.invalid_selector}`);
    }
    if (state.value_redacted) {
      throw new DemoError(
        "E_BAD_REQUEST",
        "不支持断言密码框的 value：密码字段永远读不到真实值，改用 visible 或页面上的登录态断言",
      );
    }
    const checks = buildAssertChecks(input, state);
    if (checks.every((check) => check.ok)) {
      const waited_ms = Date.now() - started;
      session.record("assert.passed", { checks: checks.length, waited_ms });
      return { ok: true, passed: true, checks, url: state.url, title: state.title, waited_ms };
    }
    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) {
      const screenshotPath = await session.captureFailure();
      session.record("assert.failed", {
        checks: checks.filter((check) => !check.ok),
        waited_ms: elapsed,
        screenshotPath,
      });
      throw new DemoError("E_ASSERTION_FAILED", `断言失败：${describeAssertFailure(checks)}`, {
        url: state.url,
        selector: input.selector,
        screenshotPath: screenshotPath ?? undefined,
        details: { checks, waited_ms: elapsed },
      });
    }
    await sleep(Math.min(200, timeoutMs - elapsed));
  }
}

export async function readAssertState(ctx: PageContext, input: MaloAssertInput): Promise<MaloAssertState> {
  const params = {
    selector: input.selector ?? null,
    visible: input.visible ?? null,
    hidden: input.hidden ?? null,
    text: input.text ?? null,
    wants_value: input.value !== undefined,
    wants_count: input.count !== undefined,
  };
  return ctx.evaluate<MaloAssertState>(`(() => {
    const params = ${JSON.stringify(params)};
    const out = {
      url: location.href,
      title: document.title,
      visible: null,
      hidden_visible: null,
      text: null,
      value: null,
      value_redacted: false,
      count: null,
      invalid_selector: null,
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    try {
      if (params.visible !== null) out.visible = isVisible(document.querySelector(params.visible));
      if (params.hidden !== null) out.hidden_visible = isVisible(document.querySelector(params.hidden));
      if (params.text !== null) {
        const host = params.selector ? document.querySelector(params.selector) : document.body;
        out.text = host ? (host.innerText || host.textContent || "").includes(params.text) : false;
      }
      if (params.wants_value) {
        const el = document.querySelector(params.selector);
        if (el && el.type === "password") {
          out.value_redacted = true;
        } else {
          out.value = el ? String(el.value ?? "") : null;
        }
      }
      if (params.wants_count) out.count = document.querySelectorAll(params.selector).length;
    } catch (error) {
      out.invalid_selector = String((error && error.message) || error);
    }
    return out;
  })()`);
}
