import { DemoError } from "../../../shared/errors";
import type { MaloFillAction } from "../../../shared/malo";
import type { SessionInternals } from "../session-internals";

export async function fillInput(session: SessionInternals, action: MaloFillAction): Promise<string> {
  const selector = action.selector;
  const text = action.text;
  const point = await session.driver.rect(selector);
  await session.driver.move({ x: point.x, y: point.y });
  await session.driver.click({ x: point.x, y: point.y });
  if (action.clear !== false) {
    await session.driver.selectAll();
    await session.driver.press("Backspace");
  }
  await session.driver.insertText(text);
  if (action.verify === false) {
    return `filled ${selector} with ${text.length} chars (unverified)`;
  }
  let state = await readEditableValue(session, selector, text);
  if (state !== null && !state.matches) {
    await session.driver.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.focus();
      if (typeof el.select === "function") el.select();
    })()`);
    await session.driver.insertText(text);
    state = await readEditableValue(session, selector, text);
  }
  if (state !== null && !state.matches) {
    await session.driver.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const text = ${JSON.stringify(text)};
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
        if (descriptor && descriptor.set) descriptor.set.call(el, text);
        else el.value = text;
      } else if (el.isContentEditable) {
        el.textContent = text;
      } else {
        return;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    state = await readEditableValue(session, selector, text);
  }
  if (state === null || !state.matches) {
    const sensitive = state?.sensitive === true;
    throw new DemoError(
      "E_FILL_NOT_LANDED",
      sensitive
        ? `fill 未落地：密码框未接受输入（focused=${state?.active ?? false}），实际值不回显`
        : `fill 未落地：期望 ${text.length} 字符，元素实际值 ${
            state === null ? "元素已不存在" : JSON.stringify(state.value)
          }（focused=${state?.active ?? false}）`,
      {
        selector,
        url: await session.driver.url(),
        details: sensitive ? { sensitive: true } : { expected: text, actual: state?.value ?? null },
      },
    );
  }
  return `filled ${selector} with ${text.length} chars (verified)`;
}

export async function readEditableValue(
  session: SessionInternals,
  selector: string,
  expected?: string,
): Promise<{ value: string | null; matches: boolean; active: boolean; sensitive: boolean } | null> {
  return session.driver.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const sensitive = el instanceof HTMLInputElement && el.type === "password";
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : (el.isContentEditable ? el.textContent || "" : null);
    const expected = ${expected === undefined ? "undefined" : JSON.stringify(expected)};
    return {
      value: sensitive ? null : value,
      matches: expected !== undefined && value === expected,
      active: document.activeElement === el,
      sensitive,
    };
  })()`);
}
