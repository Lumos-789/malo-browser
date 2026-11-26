import { DemoError } from "../../shared/errors";
import type { MaloExtractResult, FrameTarget } from "../../shared/malo";
import { resolveContext, type PageContext } from "./frames";
import type { SessionInternals } from "./session-internals";

export type ExtractInput = FrameTarget & {
  selector: string;
  mode?: "text" | "html" | "attributes" | "rect";
  attributes?: string[];
  maxChars?: number;
  all?: boolean;
};

/** 从匹配选择器的元素里取内容；给了 frame 就在那个 iframe 里找，rect 的坐标已换算到顶层视口。 */
export async function extractElements(session: SessionInternals, input: ExtractInput): Promise<MaloExtractResult> {
  session.assertOpen();
  session.touch();
  if (typeof input.selector !== "string" || input.selector.trim() === "") {
    throw new DemoError("E_UNSUPPORTED", "extract.selector 必须是非空字符串");
  }
  const mode = input.mode ?? "text";
  if (mode !== "text" && mode !== "html" && mode !== "attributes" && mode !== "rect") {
    throw new DemoError("E_UNSUPPORTED", "extract.mode 只能是 text / html / attributes / rect");
  }
  const maxChars = Math.max(0, Math.min(2_000_000, Math.floor(input.maxChars ?? 4_000)));
  const attributes = Array.isArray(input.attributes)
    ? input.attributes.filter((item): item is string => typeof item === "string").slice(0, 40)
    : [];
  const all = input.all !== false;
  const ctx = await resolveContext(session, input);
  await assertValidSelector(ctx, input.selector);
  const inFrame = ctx.frame !== null;
  const offsetX = ctx.frame?.offset.x ?? 0;
  const offsetY = ctx.frame?.offset.y ?? 0;
  const result = await ctx.evaluate<MaloExtractResult>(`(() => {
    const selector = ${JSON.stringify(input.selector)};
    const mode = ${JSON.stringify(mode)};
    const maxChars = ${JSON.stringify(maxChars)};
    const all = ${JSON.stringify(all)};
    const attributes = ${JSON.stringify(attributes)};
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const clip = (value, size) => value.length > size ? value.slice(0, size) : value;
    const selectorFor = (el) => {
      if (el.getAttribute("data-demo-id")) return '[data-demo-id="' + CSS.escape(el.getAttribute("data-demo-id")) + '"]';
      if (el.id) return "#" + CSS.escape(el.id);
      const name = el.getAttribute("name");
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      return el.tagName.toLowerCase();
    };
    const visible = (el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    let nodes = Array.from(document.querySelectorAll(selector));
    const total = nodes.length;
    if (!all) nodes = nodes.slice(0, 1);
    else nodes = nodes.slice(0, 50);
    const matches = nodes.map((el) => {
      const item = { selector: selectorFor(el), tag: el.tagName.toLowerCase(), visible: visible(el) };
      if (mode === "text") {
        const raw = el.tagName === "INPUT" && el.type === "password"
          ? "[redacted]"
          : (el.innerText || el.textContent || el.value || "");
        item.text = clip(clean(raw), maxChars);
      }
      if (mode === "html") item.html = clip(el.outerHTML || "", maxChars);
      if (mode === "rect") {
        const box = el.getBoundingClientRect();
        item.rect = {
          x: box.x + box.width / 2 + ${offsetX},
          y: box.y + box.height / 2 + ${offsetY},
          left: box.left + ${offsetX},
          top: box.top + ${offsetY},
          width: box.width,
          height: box.height,
        };
      }
      if (mode === "attributes") {
        const picked = {};
        const names = attributes.length > 0 ? attributes : Array.from(el.attributes).map((attr) => attr.name);
        for (const name of names) {
          const value = el.getAttribute(name);
          if (value !== null) picked[name] = clip(value, 1000);
        }
        item.attributes = picked;
      }
      return item;
    });
    return { selector, mode, count: total, matches, truncated: total > nodes.length };
  })()`);
  session.record("observe.extract", {
    selector: input.selector,
    mode,
    frame: ctx.frame?.index ?? null,
    count: result.count,
  });
  return inFrame ? { ...result, frame: ctx.frame?.index } : result;
}

async function assertValidSelector(ctx: PageContext, selector: string): Promise<void> {
  const error = await ctx.evaluate<string | null>(`(() => {
    try { document.querySelector(${JSON.stringify(selector)}); return null; }
    catch (error) { return String((error && error.message) || error); }
  })()`);
  if (error !== null) {
    throw new DemoError("E_BAD_REQUEST", `选择器语法错误：${error}`);
  }
}
