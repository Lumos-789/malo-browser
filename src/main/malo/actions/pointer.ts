import { DemoError } from "../../../shared/errors";
import type { MaloAction } from "../../../shared/malo";
import type { PageContext } from "../frames";
import type { SessionInternals } from "../session-internals";
import type { ActionHandler } from "./run-action";

type Point = { x: number; y: number };

/** 按可见文本定位：子串匹配、最内层可见元素优先（父容器因包含子文本也会命中，点叶子才准）。 */
export async function locateByText(
  ctx: PageContext,
  text: string,
  scopeSelector: string | undefined,
  nth: number,
): Promise<{ x: number; y: number; tag: string; snippet: string }> {
  const found = await ctx.evaluate<{
    x?: number;
    y?: number;
    tag?: string;
    snippet?: string;
    missing?: "scope" | "text";
    count?: number;
  }>(`(() => {
    const needle = ${JSON.stringify(text)};
    const scope = ${scopeSelector ? `document.querySelector(${JSON.stringify(scopeSelector)})` : "document.body"};
    if (!scope) return { missing: "scope" };
    const matches = [];
    const walk = (el) => {
      for (const child of Array.from(el.children)) walk(child);
      if (!(el.textContent || "").includes(needle)) return;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return;
      matches.push(el);
    };
    walk(scope);
    const leaves = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
    const ordered = leaves.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    const el = ordered[${JSON.stringify(nth)} - 1];
    if (!el) return { missing: "text", count: ordered.length };
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      tag: el.tagName.toLowerCase(),
      snippet: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 40),
    };
  })()`);
  const where = ctx.frame ? `第 ${ctx.frame.index} 个 iframe 里` : "";
  if (found.missing === "scope") {
    throw new DemoError("E_SELECTOR_NOT_FOUND", `click 文本范围选择器找不到：${scopeSelector}`, {
      selector: scopeSelector,
      url: await ctx.url(),
    });
  }
  if (found.missing === "text") {
    throw new DemoError(
      "E_SELECTOR_NOT_FOUND",
      `${where}找不到可点的可见文本「${text}」（候选 ${found.count ?? 0} 个）`,
      { url: await ctx.url() },
    );
  }
  const offset = ctx.frame?.offset ?? { x: 0, y: 0 };
  return {
    x: (found.x as number) + offset.x,
    y: (found.y as number) + offset.y,
    tag: found.tag as string,
    snippet: found.snippet as string,
  };
}

export const click: ActionHandler<"click"> = async (session, ctx, action) => {
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
  let point: Partial<Point>;
  let target: string | undefined;
  if (action.text !== undefined) {
    const found = await locateByText(ctx, action.text, action.selector, action.nth ?? 1);
    point = { x: found.x, y: found.y };
    target = `text「${action.text}」@${found.tag}`;
  } else if (action.selector) {
    point = await ctx.rect(action.selector);
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
};

export const hover: ActionHandler<"hover"> = async (session, ctx, action) => {
  if (action.selector !== undefined && typeof action.selector !== "string") {
    throw new DemoError("E_UNSUPPORTED", "hover.selector 必须是字符串");
  }
  const point = action.selector ? await ctx.rect(action.selector) : { x: action.x, y: action.y };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new DemoError("E_UNSUPPORTED", "hover 需要 selector 或 x/y 坐标");
  }
  await session.driver.move({ x: point.x as number, y: point.y as number });
  return `hovered ${action.selector ?? `${point.x},${point.y}`}`;
};

/** 拖拽坐标是顶层视口坐标；iframe 里的元素先用 extract mode=rect 取换算好的中心点。 */
export const drag: ActionHandler<"drag"> = async (session, _ctx, action) => {
  for (const field of ["from_x", "from_y", "to_x", "to_y"] as const) {
    if (typeof action[field] !== "number" || !Number.isFinite(action[field])) {
      throw new DemoError("E_UNSUPPORTED", `drag.${field} 必须是有限数字`);
    }
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
};

export const scroll: ActionHandler<"scroll"> = async (session, ctx, action) => {
  if (action.dx !== undefined && !Number.isFinite(action.dx)) {
    throw new DemoError("E_UNSUPPORTED", "scroll.dx 必须是有限数字");
  }
  if (action.dy !== undefined && !Number.isFinite(action.dy)) {
    throw new DemoError("E_UNSUPPORTED", "scroll.dy 必须是有限数字");
  }
  const hasX = action.x !== undefined;
  const hasY = action.y !== undefined;
  if (hasX !== hasY || (hasX && (!Number.isFinite(action.x) || !Number.isFinite(action.y)))) {
    throw new DemoError("E_UNSUPPORTED", "scroll 落点需要同时给有限的 x 和 y");
  }
  const delta = { x: action.dx ?? 0, y: action.dy ?? 0 };
  // 落点是顶层坐标：不给就落在视口中心，指定了 iframe 就落在那个 iframe 的中心
  const origin = typeof action.x === "number" && typeof action.y === "number"
    ? { x: action.x, y: action.y }
    : await ctx.center();
  await session.driver.scroll(delta, origin);
  return `scrolled ${delta.x},${delta.y} at ${origin.x},${origin.y}`;
};

export const scrollIntoView: ActionHandler<"scroll_into_view"> = async (_session, ctx, action) => {
  if (typeof action.selector !== "string" || action.selector.trim() === "") {
    throw new DemoError("E_UNSUPPORTED", "scroll_into_view.selector 必须是非空字符串");
  }
  const scrolled = await ctx.evaluate<boolean>(`(() => {
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
};
