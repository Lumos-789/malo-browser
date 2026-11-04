import { DemoError } from "../../shared/errors";
import type { SceneStep } from "../../shared/scene";
import type { Rect } from "../../shared/types";
import type { PageDriver } from "../core/page-driver";

const TEXT_TARGET_ATTR = "data-demo-runner-target";
let textTargetCounter = 0;

export type TargetSource = "data_demo_id" | "selector" | "text" | "coords";

export type ResolvedTarget = {
  /** Null for coordinate-only targets. */
  selector: string | null;
  source: TargetSource;
  rect: Rect;
};

export function stepString(step: SceneStep, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = step[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function stepNumber(step: SceneStep, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = step[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function stepBoolean(step: SceneStep, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = step[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function targetSelector(step: SceneStep): { selector: string; source: "data_demo_id" | "selector" } | null {
  const demoId = stepString(step, "data_demo_id", "dataDemoId");
  if (demoId) {
    return { selector: `[data-demo-id=${JSON.stringify(demoId)}]`, source: "data_demo_id" };
  }
  const selector = stepString(step, "selector");
  if (selector) return { selector, source: "selector" };
  return null;
}

export function hasStepTarget(step: SceneStep): boolean {
  if (targetSelector(step)) return true;
  if (stepString(step, "text")) return true;
  return stepNumber(step, "x") !== undefined && stepNumber(step, "y") !== undefined;
}

/** Annotate uses `text` as its label, so it must not be treated as a text target. */
export function hasBoxTarget(step: SceneStep): boolean {
  if (targetSelector(step)) return true;
  return stepNumber(step, "x") !== undefined && stepNumber(step, "y") !== undefined;
}

export async function resolveTarget(
  driver: PageDriver,
  step: SceneStep,
  textTargetOverride?: string,
): Promise<ResolvedTarget> {
  const direct = targetSelector(step);
  if (direct) {
    return { selector: direct.selector, source: direct.source, rect: await rectFor(driver, direct.selector) };
  }

  const text = textTargetOverride ?? stepString(step, "text");
  if (text) {
    const selector = await selectorByText(driver, text);
    return { selector, source: "text", rect: await rectFor(driver, selector) };
  }

  const x = stepNumber(step, "x");
  const y = stepNumber(step, "y");
  if (x !== undefined && y !== undefined) {
    return {
      selector: null,
      source: "coords",
      rect: { x, y, left: x, top: y, width: 0, height: 0 },
    };
  }

  throw new DemoError("E_SELECTOR_NOT_FOUND", "步骤没有可解析的点击或视觉目标", {
    selector: stepString(step, "selector"),
  });
}

async function rectFor(driver: PageDriver, selector: string): Promise<Rect> {
  try {
    return await driver.rect(selector);
  } catch (error) {
    if (error instanceof DemoError) throw error;
    throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到元素 ${selector}`, {
      selector,
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Text targets are resolved in-page once and tagged with a run-scoped attribute,
 * so the rest of the action can keep using the normal selector contract.
 */
async function selectorByText(driver: PageDriver, text: string): Promise<string> {
  textTargetCounter += 1;
  const token = `${TEXT_TARGET_ATTR}-${textTargetCounter}`;
  const selector = await driver.evaluate<string | null>(`
(() => {
  const wanted = ${JSON.stringify(text)};
  const attr = ${JSON.stringify(TEXT_TARGET_ATTR)};
  const token = ${JSON.stringify(token)};
  const elements = Array.from(document.querySelectorAll("body *"));
  let best = null;
  let bestLength = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const content = (element.innerText || element.textContent || "").trim();
    if (!content.includes(wanted)) continue;
    if (content.length < bestLength) {
      best = element;
      bestLength = content.length;
    }
  }
  if (!best) return null;
  best.setAttribute(attr, token);
  return "[" + attr + "=" + JSON.stringify(token) + "]";
})()
`);
  if (!selector) {
    throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到包含文本的可见元素：${text}`, {
      details: { text },
    });
  }
  return selector;
}
