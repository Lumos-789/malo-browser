import type { WebFrameMain } from "electron";
import { DemoError } from "../../shared/errors";
import type { Point, Rect } from "../../shared/types";
import type { SessionInternals } from "./session-internals";

/**
 * agent 用 frame=<序号> 指定「在哪个 iframe 里操作」，序号是 snapshot.frames 的下标。
 * 这里负责把页面里的 iframe 列出来、算出每个 iframe 的坐标换算，并给出统一的页面上下文：
 * 顶层页面和 iframe 里的脚本执行、元素定位走同一套接口。
 */
export type FrameEntry = {
  index: number;
  /** 父框架的序号；null = 直接挂在顶层页面上。 */
  parent: number | null;
  url: string;
  name: string;
  /** iframe 的内容框在顶层视口里的位置与大小。 */
  rect: { left: number; top: number; width: number; height: number };
  /** 框架视口原点在顶层视口里的位置：框架内坐标加上它就是可喂给鼠标事件的顶层坐标。 */
  offset: Point;
  /** 从顶层页面一路取 iframe 元素的下标，用来在页面脚本里定位到这个框架的文档。 */
  path: number[];
  frame: WebFrameMain;
};

export type PageContext = {
  /** null = 顶层页面。 */
  readonly frame: FrameEntry | null;
  evaluate<T>(expression: string): Promise<T>;
  /** 元素矩形，坐标已换算到顶层视口。 */
  rect(selector: string): Promise<Rect>;
  url(): Promise<string>;
  /** 视口中心的顶层坐标：滚轮、无坐标悬停的默认落点。 */
  center(): Promise<Point>;
};

export type FrameRef = {
  frame?: number;
  /** 可选的保险：iframe 的 URL 必须包含这个片段，否则说明页面变了、序号对不上。 */
  frame_url?: string;
};

const MAX_DEPTH = 3;

// iframe 元素的内容框（不含边框）在所在文档视口里的位置
const IFRAME_ELEMENTS_SCRIPT = `(() => Array.from(document.querySelectorAll("iframe")).map((el) => {
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return {
    x: r.left + el.clientLeft,
    y: r.top + el.clientTop,
    width: el.clientWidth,
    height: el.clientHeight,
    src: el.src || "",
    name: el.name || "",
    visible: style.display !== "none" && style.visibility !== "hidden" && r.width > 0 && r.height > 0,
  };
}))()`;

type IframeElement = {
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
  name: string;
  visible: boolean;
};

function pageError(message: string): DemoError {
  const firstLine = message.split("\n")[0];
  if (/\bSyntaxError\b/.test(message)) {
    return new DemoError("E_BAD_REQUEST", `选择器语法错误：${firstLine}`);
  }
  return new DemoError("E_UNSUPPORTED", `iframe 脚本执行失败：${firstLine}`);
}

async function evaluateInFrame<T>(entry: FrameEntry, expression: string): Promise<T> {
  if (entry.frame.detached) {
    throw new DemoError("E_SELECTOR_NOT_FOUND", `第 ${entry.index} 个 iframe 已经离开页面，请重新 snapshot 再取序号`);
  }
  try {
    return (await entry.frame.executeJavaScript(expression)) as T;
  } catch (error) {
    throw pageError(error instanceof Error ? error.message : String(error));
  }
}

export function frameContext(entry: FrameEntry): PageContext {
  const offset = entry.offset;
  return {
    frame: entry,
    evaluate: <T>(expression: string) => evaluateInFrame<T>(entry, expression),
    async rect(selector) {
      const box = await evaluateInFrame<{ x: number; y: number; left: number; top: number; width: number; height: number } | null>(
        entry,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
        })()`,
      );
      if (!box) {
        throw new DemoError("E_SELECTOR_NOT_FOUND", `第 ${entry.index} 个 iframe 里找不到元素 ${selector}`, {
          selector,
          url: entry.url,
        });
      }
      return { ...box, x: box.x + offset.x, y: box.y + offset.y, left: box.left + offset.x, top: box.top + offset.y };
    },
    url: () => Promise.resolve(entry.frame.url),
    async center() {
      const size = await evaluateInFrame<{ width: number; height: number }>(
        entry,
        "({ width: innerWidth, height: innerHeight })",
      );
      return { x: offset.x + Math.round(size.width / 2), y: offset.y + Math.round(size.height / 2) };
    },
  };
}

export function mainContext(session: SessionInternals): PageContext {
  return {
    frame: null,
    evaluate: (expression) => session.driver.evaluate(expression),
    rect: (selector) => session.driver.rect(selector),
    url: () => session.driver.url(),
    center: () => session.driver.evaluate<Point>("({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })"),
  };
}

/** 框架树与元素按顺序配对；某个框架的 URL 和同位的元素对不上、又有别的同位元素 URL 相同，就改配那个（iframe 被挪动过位置时顺序会错开）。 */
function pairFrames(children: WebFrameMain[], elements: IframeElement[]) {
  return children.map((child, position) => {
    let best = position;
    if (elements[position] && elements[position].src !== child.url) {
      const alternate = elements.findIndex(
        (element, index) => index !== position && element.src === child.url && element.src !== "",
      );
      if (alternate >= 0) best = alternate;
    }
    return { child, element: elements[best] };
  });
}

async function collect(
  session: SessionInternals,
  parent: WebFrameMain | null,
  evaluate: (expression: string) => Promise<unknown>,
  parentOffset: Point,
  parentIndex: number | null,
  parentVisible: boolean,
  parentPath: number[],
  depth: number,
  out: FrameEntry[],
): Promise<void> {
  const children = parent === null ? session.stage.view.webContents.mainFrame.frames : parent.frames;
  if (children.length === 0 || depth > MAX_DEPTH) return;
  const elements = (await evaluate(IFRAME_ELEMENTS_SCRIPT)) as IframeElement[];
  if (!Array.isArray(elements) || elements.length !== children.length) {
    throw new DemoError(
      "E_UNSUPPORTED",
      `页面的 iframe 列表正在变化（框架 ${children.length} 个、元素 ${elements.length ?? 0} 个），请重试`,
    );
  }
  for (const { child, element } of pairFrames(children, elements)) {
    const visible = parentVisible && element.visible;
    if (!visible) continue;
    const offset = { x: parentOffset.x + element.x, y: parentOffset.y + element.y };
    const path = [...parentPath, elements.indexOf(element)];
    const entry: FrameEntry = {
      index: out.length,
      parent: parentIndex,
      url: child.url,
      name: element.name || child.name,
      rect: { left: offset.x, top: offset.y, width: element.width, height: element.height },
      offset,
      path,
      frame: child,
    };
    out.push(entry);
    await collect(
      session,
      child,
      (expression) => evaluateInFrame(entry, expression),
      offset,
      entry.index,
      true,
      path,
      depth + 1,
      out,
    );
  }
}

/** 列出页面上所有看得见的 iframe（祖先也看得见才算），按文档顺序展平编号。 */
export async function listFrames(session: SessionInternals): Promise<FrameEntry[]> {
  const out: FrameEntry[] = [];
  await collect(
    session,
    null,
    (expression) => session.driver.evaluate(expression),
    { x: 0, y: 0 },
    null,
    true,
    [],
    1,
    out,
  );
  return out;
}

/** 按 agent 给的 frame / frame_url 找到目标框架；不给 frame 就是顶层页面。 */
export async function resolveContext(session: SessionInternals, ref: FrameRef): Promise<PageContext> {
  if (ref.frame === undefined) return mainContext(session);
  if (!Number.isInteger(ref.frame) || ref.frame < 0) {
    throw new DemoError("E_BAD_REQUEST", "frame 必须是非负整数（snapshot.frames 的下标）");
  }
  const frames = await listFrames(session);
  const entry = frames.find((item) => item.index === ref.frame);
  if (!entry) {
    throw new DemoError(
      "E_SELECTOR_NOT_FOUND",
      `找不到第 ${ref.frame} 个 iframe（当前可见的共 ${frames.length} 个：${frames
        .map((item) => `${item.index}=${item.url}`)
        .join("，") || "无"}）`,
    );
  }
  if (ref.frame_url !== undefined && !entry.url.includes(ref.frame_url)) {
    throw new DemoError(
      "E_SELECTOR_NOT_FOUND",
      `第 ${ref.frame} 个 iframe 的地址是 ${entry.url}，不包含 ${ref.frame_url}：页面变了，请重新 snapshot`,
    );
  }
  return frameContext(entry);
}
