import type { MaloSnapshot } from "../../shared/malo";
import type { SessionInternals } from "./session-internals";

export const SNAPSHOT_SECTIONS = [
  "text",
  "headings",
  "links",
  "buttons",
  "inputs",
  "selects",
  "forms",
  "tables",
  "landmarks",
  "interactive",
  "widgets",
  "frames",
  "dialogs",
  "messages",
] as const;

export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];

export function isSnapshotSection(value: unknown): value is SnapshotSection {
  return typeof value === "string" && (SNAPSHOT_SECTIONS as readonly string[]).includes(value);
}

export type SnapshotOptions = {
  maxChars?: number;
  maxItems?: number;
  /** 只采集并列出这些分区；不给 = 全部。没被点名的分区返回空数组。 */
  sections?: SnapshotSection[];
};

export type SnapshotLimits = {
  maxChars: number;
  maxItems: number;
  sections: SnapshotSection[] | null;
};

export function snapshotLimits(options: SnapshotOptions, scale = 1): SnapshotLimits {
  return {
    maxChars: Math.max(0, Math.min(30_000, Math.floor((options.maxChars ?? 8_000) * scale))),
    maxItems: Math.max(1, Math.min(500, Math.floor((options.maxItems ?? 120) * scale))),
    sections: options.sections === undefined ? null : [...new Set(options.sections)],
  };
}

/**
 * 页面内采集脚本：对任意框架的 document 都成立，所以顶层页面和 iframe 共用这一份。
 * 在页面里执行，不能引用模块作用域的任何东西——参数全部内联。
 */
export function buildSnapshotScript(limits: SnapshotLimits): string {
  return `(() => {
    const maxChars = ${JSON.stringify(limits.maxChars)};
    const maxItems = ${JSON.stringify(limits.maxItems)};
    const sections = ${JSON.stringify(limits.sections)};
    const want = (name) => sections === null || sections.includes(name);
    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const clip = (value, size) => value.length > size ? value.slice(0, size) : value;
    const selectorFor = (el) => {
      if (!el || el.nodeType !== 1) return "";
      const demo = el.getAttribute("data-demo-id");
      if (demo) return '[data-demo-id="' + CSS.escape(demo) + '"]';
      const testId = el.getAttribute("data-testid");
      if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
      if (el.id) return "#" + CSS.escape(el.id);
      const name = el.getAttribute("name");
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      const aria = el.getAttribute("aria-label");
      if (aria) return el.tagName.toLowerCase() + '[aria-label="' + CSS.escape(aria) + '"]';
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1 && node !== document.body) {
        let part = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
        }
        parts.unshift(part);
        node = parent;
      }
      return parts.join(" > ");
    };
    const visible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => clip(clean(
      el.tagName === "INPUT" && el.type === "password"
        ? "[redacted]"
        : (el.innerText || el.textContent || el.value || "")
    ), 300);
    // x/y 是中心点，可以直接喂给 click/drag；left/top 是左上角
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
    };
    const labelOf = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return clip(clean(aria), 200);
      if (el.id) {
        const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (label) return clip(clean(label.innerText), 200);
      }
      const closest = el.closest("label");
      return closest ? clip(clean(closest.innerText), 200) : "";
    };
    const flag = (el, name) => el.getAttribute(name) === "true";
    const truncated = {
      headings: false, links: false, buttons: false, inputs: false, selects: false,
      forms: false, tables: false, landmarks: false, interactive: false, widgets: false,
      frames: false, dialogs: false, messages: false, text: false
    };
    const take = (list, item, key) => {
      if (list.length < maxItems) list.push(item);
      else truncated[key] = true;
    };

    const headings = [];
    if (want("headings")) for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (!visible(el)) continue;
      take(headings, { level: Number(el.tagName.slice(1)), text: textOf(el), selector: selectorFor(el) }, "headings");
    }

    const links = [];
    if (want("links")) for (const el of document.querySelectorAll("a[href]")) {
      if (!visible(el)) continue;
      take(links, { text: textOf(el), href: el.href, selector: selectorFor(el) }, "links");
    }

    const buttons = [];
    if (want("buttons")) for (const el of document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')) {
      if (!visible(el)) continue;
      take(buttons, { text: textOf(el), selector: selectorFor(el), disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true" }, "buttons");
    }

    const inputs = [];
    if (want("inputs")) for (const el of document.querySelectorAll('input:not([type="hidden"]),textarea')) {
      if (!visible(el)) continue;
      const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
      const sensitive = type === "password";
      take(inputs, {
        type,
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        label: labelOf(el),
        selector: selectorFor(el),
        value: sensitive ? "" : clip(String(el.value || ""), 200),
        sensitive
      }, "inputs");
    }

    const selects = [];
    if (want("selects")) for (const el of document.querySelectorAll("select")) {
      if (!visible(el)) continue;
      take(selects, {
        name: el.getAttribute("name") || "",
        selector: selectorFor(el),
        value: String(el.value || ""),
        options: Array.from(el.options).slice(0, 50).map((option) => clean(option.text))
      }, "selects");
    }

    const forms = [];
    if (want("forms")) for (const el of document.querySelectorAll("form")) {
      if (!visible(el)) continue;
      take(forms, {
        action: el.action || "",
        method: (el.method || "get").toLowerCase(),
        selector: selectorFor(el),
        fields: el.elements ? el.elements.length : 0
      }, "forms");
    }

    const tables = [];
    if (want("tables")) for (const table of document.querySelectorAll("table")) {
      if (!visible(table)) continue;
      const headRow = table.querySelector("thead tr") || table.querySelector("tr");
      const headers = headRow
        ? Array.from(headRow.querySelectorAll("th,td")).map((cell) => clip(clean(cell.innerText), 120))
        : [];
      const rows = [];
      let tableTruncated = false;
      for (const tr of table.querySelectorAll("tbody tr, tr")) {
        if (tr === headRow) continue;
        if (rows.length >= 30) { tableTruncated = true; break; }
        const cells = Array.from(tr.querySelectorAll("th,td")).map((cell) => clip(clean(cell.innerText), 120));
        if (cells.length > 0) rows.push(cells);
      }
      if (tableTruncated) truncated.tables = true;
      take(tables, { headers, rows, truncated: tableTruncated }, "tables");
    }

    const landmarks = [];
    const roleFor = (el) => el.getAttribute("role") || ({
      HEADER: "banner", NAV: "navigation", MAIN: "main", ASIDE: "complementary",
      FOOTER: "contentinfo", FORM: "form"
    }[el.tagName] || "");
    if (want("landmarks")) for (const el of document.querySelectorAll('header,nav,main,aside,footer,form,[role="banner"],[role="navigation"],[role="main"],[role="complementary"],[role="contentinfo"],[role="region"]')) {
      if (!visible(el)) continue;
      take(landmarks, {
        role: roleFor(el),
        label: clip(clean(el.getAttribute("aria-label") || el.querySelector("h1,h2,h3")?.innerText || ""), 200),
        selector: selectorFor(el)
      }, "landmarks");
    }

    const interactive = [];
    const seen = new Set();
    if (want("interactive")) for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[tabindex]:not([tabindex="-1"])')) {
      if (!visible(el) || seen.has(el)) continue;
      seen.add(el);
      take(interactive, {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        text: textOf(el),
        selector: selectorFor(el),
        rect: rectOf(el)
      }, "interactive");
    }

    // 自定义组件：没有原生标签、靠 role 表达语义的可操作元素
    const widgets = [];
    if (want("widgets")) for (const el of document.querySelectorAll('[role="tab"],[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="switch"],[role="checkbox"],[role="radio"],[role="link"],[role="treeitem"],[role="combobox"],[role="slider"],[role="spinbutton"]')) {
      if (!visible(el)) continue;
      take(widgets, {
        role: el.getAttribute("role"),
        tag: el.tagName.toLowerCase(),
        text: textOf(el),
        selector: selectorFor(el),
        disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        selected: flag(el, "aria-selected"),
        checked: flag(el, "aria-checked"),
        expanded: flag(el, "aria-expanded")
      }, "widgets");
    }

    const frames = [];
    if (want("frames")) for (const el of document.querySelectorAll("iframe")) {
      if (!visible(el)) continue;
      take(frames, { url: el.src || "", name: el.name || "", title: el.title || "" }, "frames");
    }

    const dialogs = [];
    if (want("dialogs")) for (const el of document.querySelectorAll('dialog[open],[role="dialog"]')) {
      if (!visible(el)) continue;
      take(dialogs, { text: clip(textOf(el), 1000), selector: selectorFor(el) }, "dialogs");
    }

    const messages = [];
    if (want("messages")) for (const el of document.querySelectorAll('[role="alert"],[aria-live]')) {
      if (!visible(el)) continue;
      take(messages, { text: clip(textOf(el), 1000), selector: selectorFor(el) }, "messages");
    }

    const wantsText = want("text");
    const body = document.body;
    const text = wantsText ? clean(body && body.innerText ? body.innerText : "") : "";
    if (text.length > maxChars) truncated.text = true;
    return {
      url: location.href,
      title: document.title || "",
      ready_state: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight },
      text: text.slice(0, maxChars),
      text_length: text.length,
      headings, links, buttons, inputs, selects, forms, tables, landmarks, interactive, widgets, frames, dialogs, messages,
      truncated
    };
  })()`;
}

export async function snapshotPage(
  session: SessionInternals,
  options: SnapshotOptions = {},
): Promise<MaloSnapshot> {
  session.assertOpen();
  session.touch();
  const limits = snapshotLimits(options);
  const snapshot = await session.driver.evaluate<MaloSnapshot>(buildSnapshotScript(limits));
  session.record("observe.snapshot", {
    sections: limits.sections,
    links: snapshot.links.length,
    buttons: snapshot.buttons.length,
    inputs: snapshot.inputs.length,
    text_length: snapshot.text_length,
  });
  return snapshot;
}
