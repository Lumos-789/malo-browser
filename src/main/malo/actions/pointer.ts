import { DemoError } from "../../../shared/errors";
import type { SessionInternals } from "../session-internals";

export async function locateByText(
  session: SessionInternals,
  text: string,
  scopeSelector: string | undefined,
  nth: number,
): Promise<{ x: number; y: number; tag: string; snippet: string }> {
  const found = await session.driver.evaluate<{
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
  if (found.missing === "scope") {
    throw new DemoError("E_SELECTOR_NOT_FOUND", `click 文本范围选择器找不到：${scopeSelector}`, {
      selector: scopeSelector,
      url: await session.driver.url(),
    });
  }
  if (found.missing === "text") {
    throw new DemoError(
      "E_SELECTOR_NOT_FOUND",
      `找不到可点的可见文本「${text}」（候选 ${found.count ?? 0} 个）`,
      { url: await session.driver.url() },
    );
  }
  return { x: found.x as number, y: found.y as number, tag: found.tag as string, snippet: found.snippet as string };
}
