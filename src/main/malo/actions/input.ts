import { DemoError } from "../../../shared/errors";
import type { MaloFillAction } from "../../../shared/malo";
import { NAMED_KEY_NAMES, isSupportedKey } from "../../keys";
import type { PageContext } from "../frames";
import type { SessionInternals } from "../session-internals";
import type { ActionHandler } from "./run-action";

/**
 * fill 落地链（ep014 抖音标题框判例：合成输入可能被受控组件吞掉，流程回执≠值落地）：
 * 正路 click+insertText 打完先回读；没落地换 JS 聚焦重打；再不行用原生 value
 * setter + input/change 事件绕过输入管线注入（React/Vue 受控组件的标准通路）。
 * 三层之后值仍不符才报 E_FILL_NOT_LANDED，带实际值证据，绝不报假成功。
 */
export const fill: ActionHandler<"fill"> = async (session, ctx, action) => {
  if (typeof action.selector !== "string" || action.selector.trim() === "") {
    throw new DemoError("E_UNSUPPORTED", "fill.selector 必须是非空字符串");
  }
  if (typeof action.text !== "string") {
    throw new DemoError("E_UNSUPPORTED", "fill.text 必须是字符串");
  }
  if (action.verify !== undefined && typeof action.verify !== "boolean") {
    throw new DemoError("E_UNSUPPORTED", "fill.verify 必须是布尔值");
  }
  const selector = action.selector;
  const text = action.text;
  const point = await ctx.rect(selector);
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
  let state = await readEditableValue(ctx, selector, text);
  if (state !== null && !state.matches) {
    await ctx.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.focus();
      if (typeof el.select === "function") el.select();
    })()`);
    await session.driver.insertText(text);
    state = await readEditableValue(ctx, selector, text);
  }
  if (state !== null && !state.matches) {
    await ctx.evaluate(`(() => {
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
    state = await readEditableValue(ctx, selector, text);
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
        url: await ctx.url(),
        details: sensitive ? { sensitive: true } : { expected: text, actual: state?.value ?? null },
      },
    );
  }
  return `filled ${selector} with ${text.length} chars (verified)`;
};

/**
 * 回读可编辑元素：值比对在页面内完成只回 boolean——密码框绝不回传明文
 * （matches 仍可用），非敏感字段带实际值方便报错取证。
 */
async function readEditableValue(
  ctx: PageContext,
  selector: string,
  expected?: string,
): Promise<{ value: string | null; matches: boolean; active: boolean; sensitive: boolean } | null> {
  return ctx.evaluate(`(() => {
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

export const type: ActionHandler<"type"> = async (session, _ctx, action) => {
  if (typeof action.text !== "string" || action.text === "") {
    throw new DemoError("E_UNSUPPORTED", "type.text 必须是非空字符串");
  }
  if (action.text.length > 5_000) {
    throw new DemoError("E_UNSUPPORTED", "type.text 最长 5000 字符，长文本请用 fill");
  }
  const delay = action.delay_ms ?? 0;
  if (!Number.isInteger(delay) || delay < 0 || delay > 1000) {
    throw new DemoError("E_UNSUPPORTED", "type.delay_ms 必须是 0-1000 的整数");
  }
  await session.driver.typeText(action.text, delay);
  return `typed ${[...action.text].length} chars`;
};

export const press: ActionHandler<"press"> = async (session, _ctx, action) => {
  if (typeof action.key !== "string" || action.key === "") {
    throw new DemoError("E_UNSUPPORTED", "press.key 必须是非空字符串");
  }
  if (!isSupportedKey(action.key)) {
    throw new DemoError(
      "E_UNSUPPORTED",
      `press.key 不支持：${action.key}；可用单字符或 ${NAMED_KEY_NAMES.join(" / ")}`,
    );
  }
  if (
    action.modifiers !== undefined &&
    (!Number.isInteger(action.modifiers) || action.modifiers < 0 || action.modifiers > 15)
  ) {
    throw new DemoError("E_UNSUPPORTED", "press.modifiers 必须是 0-15 的整数位掩码");
  }
  await session.driver.press(action.key, action.modifiers ?? 0);
  return `pressed ${action.key}`;
};

export const select: ActionHandler<"select"> = async (_session, ctx, action) => {
  if (typeof action.selector !== "string" || action.selector.trim() === "") {
    throw new DemoError("E_UNSUPPORTED", "select.selector 必须是非空字符串");
  }
  if (action.value === undefined && action.label === undefined) {
    throw new DemoError("E_UNSUPPORTED", "select 需要 value 或 label");
  }
  const result = await ctx.evaluate<string>(`(() => {
    const el = document.querySelector(${JSON.stringify(action.selector)});
    if (!el) return "__MISSING__";
    if (el.tagName !== "SELECT") return "__NOT_SELECT__";
    const value = ${JSON.stringify(action.value ?? null)};
    const label = ${JSON.stringify(action.label ?? null)};
    if (value !== null) {
      if (!Array.from(el.options).some((item) => item.value === value)) return "__NO_VALUE__";
      el.value = value;
    } else {
      const option = Array.from(el.options).find((item) => item.text.trim() === label);
      if (!option) return "__NO_OPTION__";
      el.value = option.value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return String(el.value);
  })()`);
  if (result === "__MISSING__") {
    throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到元素 ${action.selector}`, {
      selector: action.selector,
    });
  }
  if (result === "__NOT_SELECT__") {
    throw new DemoError("E_UNSUPPORTED", `元素不是 select：${action.selector}`);
  }
  if (result === "__NO_OPTION__") {
    throw new DemoError("E_UNSUPPORTED", `找不到选项 label：${action.label}`);
  }
  if (result === "__NO_VALUE__") {
    throw new DemoError("E_UNSUPPORTED", `找不到选项 value：${action.value}`);
  }
  return `selected ${action.selector}=${result}`;
};

export const focus: ActionHandler<"focus"> = async (_session, ctx, action) => {
  if (typeof action.selector !== "string" || action.selector.trim() === "") {
    throw new DemoError("E_UNSUPPORTED", "focus.selector 必须是非空字符串");
  }
  const focused = await ctx.evaluate<boolean>(`(() => {
    const el = document.querySelector(${JSON.stringify(action.selector)});
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!focused) {
    throw new DemoError("E_SELECTOR_NOT_FOUND", `无法聚焦元素 ${action.selector}`, {
      selector: action.selector,
    });
  }
  return `focused ${action.selector}`;
};

const UPLOAD_OBJECT_GROUP = "malo-upload";

/**
 * 往 input[type=file] 上放文件。顶层页面走 CDP 的 DOM 节点；iframe 里只有同源的够得着——
 * 跨域 iframe 的文档主页面碰不到，Chromium 也不把它放进同一个调试会话。
 */
export const uploadFile: ActionHandler<"upload_file"> = async (session, ctx, action) => {
  if (typeof action.selector !== "string" || action.selector.trim() === "") {
    throw new DemoError("E_UNSUPPORTED", "upload_file.selector 必须是非空字符串");
  }
  if (!Array.isArray(action.files) || action.files.length === 0) {
    throw new DemoError("E_UNSUPPORTED", "upload_file.files 必须是非空字符串数组");
  }
  if (action.files.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new DemoError("E_UNSUPPORTED", "upload_file.files 必须是非空字符串数组");
  }
  const frame = ctx.frame;
  if (frame === null) {
    await session.driver.uploadFiles(action.selector, action.files);
    return `uploaded ${action.files.length} file(s) to ${action.selector}`;
  }
  const hop = (index: number) =>
    index === 0
      ? `document.querySelectorAll("iframe")[${frame.path[0]}]`
      : `.contentDocument.querySelectorAll("iframe")[${frame.path[index]}]`;
  const expression = `${frame.path.map(hop).join("")}.contentDocument.querySelector(${JSON.stringify(action.selector)})`;
  // 跨域 iframe 的 contentDocument 是 null，表达式会直接抛异常：抛出来的错误对象也带句柄，必须先看有没有异常
  const evaluated = await session.driver.send<{
    result: { objectId?: string };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", { expression, objectGroup: UPLOAD_OBJECT_GROUP });
  if (evaluated.exceptionDetails || !evaluated.result.objectId) {
    throw new DemoError("E_UNSUPPORTED", `第 ${frame.index} 个 iframe 里找不到文件输入框 ${action.selector}，或它是跨域的：跨域 iframe 里不能上传文件`, {
      selector: action.selector,
      url: frame.url,
    });
  }
  try {
    // 按页面对象句柄直接设文件：同源 iframe 的节点不在主页面的调试节点树里，转节点号会找不到
    await session.driver.send("DOM.setFileInputFiles", {
      objectId: evaluated.result.objectId,
      files: action.files,
    });
  } finally {
    await session.driver.send("Runtime.releaseObjectGroup", { objectGroup: UPLOAD_OBJECT_GROUP }).catch(() => undefined);
  }
  return `uploaded ${action.files.length} file(s) to ${action.selector} in iframe ${frame.index}`;
};
