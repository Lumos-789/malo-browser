import { DemoError, stripErrorCode } from "../../../shared/errors";
import type { MaloAction, MaloActionResult } from "../../../shared/malo";
import { sleep } from "../../tools";
import { fillInput } from "./input";
import { NAMED_KEY_NAMES, isSupportedKey } from "../../keys";
import { locateByText } from "./pointer";
import type { SessionInternals } from "../session-internals";
import { observePage } from "../observation";

export async function runAction(
  session: SessionInternals,
  action: MaloAction,
  timeoutMs: number,
): Promise<MaloActionResult> {
  session.assertOpen();
  session.touch();
  const boundedTimeout = Math.max(100, Math.min(120_000, Math.floor(timeoutMs)));
  session.record("action.started", { action: action.type });
  const popupBefore = session.popupSeq;
  try {
    const detail = await executeAction(session, action, boundedTimeout);
    const observation = await observePage(session, "light", 2_000);
    session.record("action.completed", { action: action.type, detail });
    // 这个动作触发了 window.open：把目标地址带回给 agent（被拦下，或 adopt 模式下已在当前页面打开）
    const popup = session.popupSeq === popupBefore ? {} : { popup: session.lastPopup ?? undefined };
    return { action: action.type, detail, observation, ...popup };
  } catch (error) {
    const screenshotPath = await session.captureFailure();
    const message = error instanceof Error ? error.message : String(error);
    session.record("action.failed", { action: action.type, message, screenshotPath });
    if (error instanceof DemoError) {
      throw new DemoError(error.code, stripErrorCode(error.code, message), {
        ...error.toDetail(),
        screenshotPath: screenshotPath ?? error.screenshotPath,
      });
    }
    throw new DemoError("E_UNSUPPORTED", message, { screenshotPath: screenshotPath ?? undefined });
  }
}

export async function executeAction(
  session: SessionInternals,
  action: MaloAction,
  timeoutMs: number,
): Promise<string> {
  switch (action.type) {
    case "click": {
      if (action.selector !== undefined && typeof action.selector !== "string") {
        throw new DemoError("E_UNSUPPORTED", "click.selector 必须是字符串");
      }
      if (action.text !== undefined && (typeof action.text !== "string" || action.text.trim() === "")) {
        throw new DemoError("E_UNSUPPORTED", "click.text 必须是非空字符串");
      }
      if (action.nth !== undefined && (!Number.isInteger(action.nth) || action.nth < 1)) {
        throw new DemoError("E_UNSUPPORTED", "click.nth 必须是正整数");
      }
      const button = action.button ?? "left";
      if (button !== "left" && button !== "middle" && button !== "right") {
        throw new DemoError("E_UNSUPPORTED", "click.button 只能是 left / middle / right");
      }
      const clickCount = action.click_count ?? 1;
      if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
        throw new DemoError("E_UNSUPPORTED", "click.click_count 必须是 1-3 的整数");
      }
      let point: { x?: number; y?: number };
      let target: string | undefined;
      if (action.text !== undefined) {
        const found = await locateByText(session, action.text, action.selector, action.nth ?? 1);
        point = { x: found.x, y: found.y };
        target = `text「${action.text}」@${found.tag}`;
      } else if (action.selector) {
        point = await session.driver.rect(action.selector);
        target = action.selector;
      } else {
        point = { x: action.x, y: action.y };
      }
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new DemoError("E_UNSUPPORTED", "click 需要 selector、text 或 x/y 坐标");
      }
      await session.driver.move({ x: point.x as number, y: point.y as number });
      await session.driver.click(
        { x: point.x as number, y: point.y as number },
        { button, clickCount },
      );
      return `clicked ${target ?? `${point.x},${point.y}`}`;
    }
    case "fill": {
      if (typeof action.selector !== "string" || action.selector.trim() === "") {
        throw new DemoError("E_UNSUPPORTED", "fill.selector 必须是非空字符串");
      }
      if (typeof action.text !== "string") {
        throw new DemoError("E_UNSUPPORTED", "fill.text 必须是字符串");
      }
      if (action.verify !== undefined && typeof action.verify !== "boolean") {
        throw new DemoError("E_UNSUPPORTED", "fill.verify 必须是布尔值");
      }
      return await fillInput(session, action);
    }
    case "drag": {
      if (typeof action.from_x !== "number" || !Number.isFinite(action.from_x)) {
        throw new DemoError("E_UNSUPPORTED", "drag.from_x 必须是有限数字");
      }
      if (typeof action.from_y !== "number" || !Number.isFinite(action.from_y)) {
        throw new DemoError("E_UNSUPPORTED", "drag.from_y 必须是有限数字");
      }
      if (typeof action.to_x !== "number" || !Number.isFinite(action.to_x)) {
        throw new DemoError("E_UNSUPPORTED", "drag.to_x 必须是有限数字");
      }
      if (typeof action.to_y !== "number" || !Number.isFinite(action.to_y)) {
        throw new DemoError("E_UNSUPPORTED", "drag.to_y 必须是有限数字");
      }
      const steps = action.steps ?? 12;
      if (!Number.isInteger(steps) || steps < 1 || steps > 100) {
        throw new DemoError("E_UNSUPPORTED", "drag.steps 必须是 1-100 的整数");
      }
      await session.driver.drag(
        { x: action.from_x, y: action.from_y },
        { x: action.to_x, y: action.to_y },
        steps,
      );
      return `dragged (${action.from_x},${action.from_y}) -> (${action.to_x},${action.to_y}) in ${steps} steps`;
    }
    case "upload_file": {
      if (typeof action.selector !== "string" || action.selector.trim() === "") {
        throw new DemoError("E_UNSUPPORTED", "upload_file.selector 必须是非空字符串");
      }
      if (!Array.isArray(action.files) || action.files.length === 0) {
        throw new DemoError("E_UNSUPPORTED", "upload_file.files 必须是非空字符串数组");
      }
      if (action.files.some((item) => typeof item !== "string" || item.trim() === "")) {
        throw new DemoError("E_UNSUPPORTED", "upload_file.files 必须是非空字符串数组");
      }
      await session.driver.uploadFiles(action.selector, action.files);
      return `uploaded ${action.files.length} file(s) to ${action.selector}`;
    }
    case "press": {
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
    }
    case "scroll": {
      if (action.dx !== undefined && !Number.isFinite(action.dx)) {
        throw new DemoError("E_UNSUPPORTED", "scroll.dx 必须是有限数字");
      }
      if (action.dy !== undefined && !Number.isFinite(action.dy)) {
        throw new DemoError("E_UNSUPPORTED", "scroll.dy 必须是有限数字");
      }
      const hasX = action.x !== undefined;
      const hasY = action.y !== undefined;
      if ((hasX !== hasY || (hasX && (!Number.isFinite(action.x) || !Number.isFinite(action.y))))) {
        throw new DemoError("E_UNSUPPORTED", "scroll 落点需要同时给有限的 x 和 y");
      }
      const delta = { x: action.dx ?? 0, y: action.dy ?? 0 };
      const origin = typeof action.x === "number" && typeof action.y === "number"
        ? { x: action.x, y: action.y }
        : undefined;
      await session.driver.scroll(delta, origin);
      return `scrolled ${delta.x},${delta.y}${origin ? ` at ${origin.x},${origin.y}` : ""}`;
    }
    case "type": {
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
    }
    case "hover": {
      if (action.selector !== undefined && typeof action.selector !== "string") {
        throw new DemoError("E_UNSUPPORTED", "hover.selector 必须是字符串");
      }
      const point = action.selector
        ? await session.driver.rect(action.selector)
        : { x: action.x, y: action.y };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new DemoError("E_UNSUPPORTED", "hover 需要 selector 或 x/y 坐标");
      }
      await session.driver.move({ x: point.x as number, y: point.y as number });
      return `hovered ${action.selector ?? `${point.x},${point.y}`}`;
    }
    case "select": {
      if (typeof action.selector !== "string" || action.selector.trim() === "") {
        throw new DemoError("E_UNSUPPORTED", "select.selector 必须是非空字符串");
      }
      if (action.value === undefined && action.label === undefined) {
        throw new DemoError("E_UNSUPPORTED", "select 需要 value 或 label");
      }
      const result = await session.driver.evaluate<string>(`(() => {
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
    }
    case "focus": {
      if (typeof action.selector !== "string" || action.selector.trim() === "") {
        throw new DemoError("E_UNSUPPORTED", "focus.selector 必须是非空字符串");
      }
      const focused = await session.driver.evaluate<boolean>(`(() => {
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
    }
    case "scroll_into_view": {
      if (typeof action.selector !== "string" || action.selector.trim() === "") {
        throw new DemoError("E_UNSUPPORTED", "scroll_into_view.selector 必须是非空字符串");
      }
      const scrolled = await session.driver.evaluate<boolean>(`(() => {
        const el = document.querySelector(${JSON.stringify(action.selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return true;
      })()`);
      if (!scrolled) {
        throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到元素 ${action.selector}`, {
          selector: action.selector,
        });
      }
      return `scrolled into view ${action.selector}`;
    }
    case "history": {
      if (action.action !== "back" && action.action !== "forward" && action.action !== "reload") {
        throw new DemoError("E_UNSUPPORTED", "history.action 只能是 back / forward / reload");
      }
      const wc = session.stage.view.webContents;
      const history = wc.navigationHistory;
      if (action.action === "back") history.goBack();
      else if (action.action === "forward") history.goForward();
      else wc.reload();
      await sleep(300);
      return `history ${action.action}`;
    }
    case "wait_for": {
      if (action.timeout_ms !== undefined && (!Number.isFinite(action.timeout_ms) || action.timeout_ms < 0)) {
        throw new DemoError("E_UNSUPPORTED", "wait_for.timeout_ms 必须是非负数字");
      }
      if (action.selector) {
        const state = action.state ?? "visible";
        if (state !== "attached" && state !== "visible" && state !== "hidden") {
          throw new DemoError("E_UNSUPPORTED", "wait_for.state 只能是 attached / visible / hidden");
        }
        await session.driver.waitForSelector(action.selector, state, action.timeout_ms ?? timeoutMs);
        return `selector ${state}: ${action.selector}`;
      }
      if (action.text) {
        await session.driver.waitForText(action.text, action.timeout_ms ?? timeoutMs);
        return `text appeared: ${action.text}`;
      }
      throw new DemoError("E_UNSUPPORTED", "wait_for 需要 selector 或 text");
    }
    case "sleep": {
      if (!Number.isFinite(action.ms) || action.ms < 0 || action.ms > 120_000) {
        throw new DemoError("E_UNSUPPORTED", "sleep.ms 必须是 0-120000 的毫秒数");
      }
      await sleep(action.ms);
      return `slept ${action.ms}ms`;
    }
    default: {
      const unknown = action as { type?: string };
      throw new DemoError("E_UNSUPPORTED", `未知动作：${unknown.type ?? ""}`);
    }
  }
}
