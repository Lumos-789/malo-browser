import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DemoError } from "../../shared/errors";
import type { Scene, SceneStep } from "../../shared/scene";
import type { Rect } from "../../shared/types";
import type { PageDriver, WaitState } from "../core/page-driver";
import type { OverlayPort } from "../core/ports";
import { loginWithAccount } from "./login";
import {
  hasBoxTarget,
  resolveTarget,
  stepBoolean,
  stepNumber,
  stepString,
  targetSelector,
} from "./targets";

export const VISUAL_ACTIONS = new Set(["highlight", "spotlight", "annotate", "mask", "blackout"]);

export type ActionContext = {
  driver: PageDriver;
  overlay: OverlayPort;
  scene: Scene;
  step: SceneStep;
  index: number;
  screenshotDir: string;
  vars: Record<string, string>;
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  resolveScene?: (sceneId: string) => Promise<Scene>;
};

export type ActionResult = {
  detail?: string;
  switchedScene?: Scene;
};

export async function executeAction(context: ActionContext): Promise<ActionResult> {
  const { step } = context;
  switch (step.action) {
    case "goto":
      return goto(context);
    case "login":
      return login(context);
    case "wait":
      return wait(context);
    case "wait_for":
      return waitFor(context);
    case "wait_for_presenter":
      return { detail: "waiting for presenter" };
    case "click":
      return click(context);
    case "fill":
      return fill(context);
    case "press":
      return press(context);
    case "scroll":
      return scroll(context);
    case "highlight":
      return highlight(context);
    case "spotlight":
      return spotlight(context);
    case "annotate":
      return annotate(context);
    case "mask":
      return mask(context);
    case "blackout":
      return blackout(context);
    case "assert":
      return assertStep(context);
    case "scene":
      return switchScene(context);
    case "set":
      return setVar(context);
    case "note":
      return { detail: stepString(step, "text", "note") ?? "note" };
    case "screenshot":
      return screenshot(context);
    default:
      throw new DemoError("E_SCENE_INVALID", `未知动作：${step.action}`, {
        sceneId: context.scene.id,
        stepIndex: context.index,
      });
  }
}

export function interpolate(value: string, vars: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    if (name.startsWith("env:")) {
      const envName = name.slice(4);
      const envValue = process.env[envName];
      if (envValue === undefined || envValue === "") {
        throw new DemoError("E_SCENE_INVALID", `环境变量缺失：${envName}`, {
          details: { variable: envName },
        });
      }
      return envValue;
    }
    const valueFromScene = vars[name];
    if (valueFromScene === undefined) {
      throw new DemoError("E_SCENE_INVALID", `场景变量缺失：${name}`, {
        details: { variable: name },
      });
    }
    return valueFromScene;
  });
}

export function resolveScreenshotPath(baseDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new DemoError("E_SCENE_INVALID", `截图路径必须是相对路径：${relativePath}`, {
      details: { path: relativePath },
    });
  }
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new DemoError("E_SCENE_INVALID", `截图路径越出截图目录：${relativePath}`, {
      details: { path: relativePath },
    });
  }
  return target;
}

async function goto(context: ActionContext): Promise<ActionResult> {
  const rawUrl = stepString(context.step, "url");
  if (!rawUrl) throw invalid(context, "goto 缺少 url");
  const url = interpolate(rawUrl, context.vars);
  await context.driver.navigate(url, { timeoutMs: context.timeoutMs });
  return { detail: `navigated to ${url}` };
}

async function login(context: ActionContext): Promise<ActionResult> {
  const accountId = stepString(context.step, "accountId", "account_id");
  if (!accountId) throw invalid(context, "login 缺少 account_id");
  return loginWithAccount({
    driver: context.driver,
    scene: context.scene,
    accountId,
    timeoutMs: context.timeoutMs,
  });
}

async function wait(context: ActionContext): Promise<ActionResult> {
  const seconds = stepNumber(context.step, "seconds");
  if (seconds === undefined || seconds < 0) throw invalid(context, "wait 缺少非负 seconds");
  await context.sleep(seconds * 1000);
  return { detail: `waited ${seconds}s` };
}

async function waitFor(context: ActionContext): Promise<ActionResult> {
  const selectorTarget = targetSelector(interpolatedTargetStep(context, false));
  const text = stepString(context.step, "text");
  const url = stepString(context.step, "url");
  if (!selectorTarget && !text && !url) {
    throw invalid(context, "wait_for 需要 selector、text 或 url");
  }
  if (selectorTarget) {
    const state = waitState(context.step, "visible");
    await context.driver.waitForSelector(selectorTarget.selector, state, context.timeoutMs);
    return { detail: `selector ${state}: ${selectorTarget.selector}` };
  }
  if (text) {
    const value = interpolate(text, context.vars);
    await context.driver.waitForText(value, context.timeoutMs);
    return { detail: `text appeared: ${value}` };
  }
  const value = interpolate(url as string, context.vars);
  await context.driver.waitForUrl(value, context.timeoutMs);
  return { detail: `url contains: ${value}` };
}

async function click(context: ActionContext): Promise<ActionResult> {
  const target = await resolveTarget(context.driver, interpolatedTargetStep(context, true));
  const button = clickButton(context.step);
  const clickCount = clickCountValue(context.step);
  await context.driver.move({ x: target.rect.x, y: target.rect.y });
  await context.overlay.move({ x: target.rect.x, y: target.rect.y });
  await context.overlay.click({ x: target.rect.x, y: target.rect.y });
  await context.driver.click({ x: target.rect.x, y: target.rect.y }, { button, clickCount });
  return {
    detail: `clicked ${target.source}${target.selector ? ` ${target.selector}` : ""} at (${round(target.rect.x)}, ${round(target.rect.y)})`,
  };
}

async function fill(context: ActionContext): Promise<ActionResult> {
  const text = stepString(context.step, "text");
  if (text === undefined) throw invalid(context, "fill 缺少 text");
  const value = interpolate(text, context.vars);
  const targetText = stepString(context.step, "target_text", "targetText");
  if (!hasBoxTarget(context.step) && !targetText) {
    throw invalid(context, "fill 需要 selector、data_demo_id、target_text 或坐标");
  }
  const target = await resolveTarget(
    context.driver,
    interpolatedTargetStep(context, false),
    targetText ? interpolate(targetText, context.vars) : "",
  );
  await context.driver.move({ x: target.rect.x, y: target.rect.y });
  await context.overlay.move({ x: target.rect.x, y: target.rect.y });
  await context.overlay.click({ x: target.rect.x, y: target.rect.y });
  await context.driver.click({ x: target.rect.x, y: target.rect.y }, { button: "left", clickCount: 1 });
  if (stepBoolean(context.step, "clear") !== false) {
    await context.driver.selectAll();
    await context.driver.press("Backspace");
  }
  if (stepBoolean(context.step, "key_events", "keyEvents") === true) {
    for (const character of value) await context.driver.insertText(character);
  } else {
    await context.driver.insertText(value);
  }
  return { detail: `filled ${target.selector ?? "target"} with ${value.length} chars` };
}

async function press(context: ActionContext): Promise<ActionResult> {
  const key = stepString(context.step, "key");
  if (!key) throw invalid(context, "press 缺少 key");
  const modifiers = stepNumber(context.step, "modifiers") ?? 0;
  await context.driver.press(interpolate(key, context.vars), modifiers);
  return { detail: `pressed ${key}` };
}

async function scroll(context: ActionContext): Promise<ActionResult> {
  const dx = stepNumber(context.step, "dx") ?? 0;
  const dy = stepNumber(context.step, "dy") ?? 0;
  const selectorTarget = targetSelector(interpolatedTargetStep(context, false));
  if (selectorTarget) {
    const rect = await context.driver.rect(selectorTarget.selector);
    await context.driver.move({ x: rect.x, y: rect.y });
    await context.overlay.move({ x: rect.x, y: rect.y });
  }
  await context.driver.scroll({ x: dx, y: dy });
  return { detail: `scrolled (${dx}, ${dy})` };
}

async function highlight(context: ActionContext): Promise<ActionResult> {
  const target = await resolveTarget(context.driver, interpolatedTargetStep(context, true));
  const seconds = stepNumber(context.step, "seconds") ?? 1.2;
  const rawColor = stepString(context.step, "color");
  const color = rawColor ? interpolate(rawColor, context.vars) : undefined;
  await context.overlay.highlight(target.rect, seconds, color);
  return { detail: `highlighted ${target.selector ?? "target"}` };
}

async function spotlight(context: ActionContext): Promise<ActionResult> {
  const target = await resolveTarget(context.driver, interpolatedTargetStep(context, true));
  await context.overlay.spotlight(target.rect, {
    padding: stepNumber(context.step, "padding"),
    dim: stepNumber(context.step, "dim"),
    seconds: stepNumber(context.step, "seconds"),
  });
  return { detail: `spotlighted ${target.selector ?? "target"}` };
}

async function annotate(context: ActionContext): Promise<ActionResult> {
  const text = stepString(context.step, "text");
  if (!text) throw invalid(context, "annotate 缺少 text");
  if (!hasBoxTarget(context.step)) throw invalid(context, "annotate 需要 selector、data_demo_id 或坐标");
  const target = await resolveTarget(context.driver, interpolatedTargetStep(context, false), "");
  await context.overlay.annotate(target.rect, {
    text: interpolate(text, context.vars),
    position: annotationPosition(context.step),
    seconds: stepNumber(context.step, "seconds"),
  });
  return { detail: `annotated ${target.selector ?? "target"}` };
}

async function mask(context: ActionContext): Promise<ActionResult> {
  const target = await resolveTarget(context.driver, interpolatedTargetStep(context, true));
  const mode = stepString(context.step, "mode");
  if (mode !== undefined && mode !== "blur" && mode !== "solid") {
    throw invalid(context, `mask mode 非法：${mode}`);
  }
  const rawColor = stepString(context.step, "color");
  await context.overlay.mask(target.rect, {
    mode: mode as "blur" | "solid" | undefined,
    color: rawColor ? interpolate(rawColor, context.vars) : undefined,
  });
  return { detail: `masked ${target.selector ?? "target"}` };
}

async function blackout(context: ActionContext): Promise<ActionResult> {
  const on = stepBoolean(context.step, "on");
  if (on === undefined) throw invalid(context, "blackout 缺少 on");
  await context.overlay.blackout(on);
  return { detail: `blackout ${on ? "on" : "off"}` };
}

async function assertStep(context: ActionContext): Promise<ActionResult> {
  const visible = context.step.visible;
  const expectedText = stepString(context.step, "text");
  const expectedValue = typeof context.step.value === "string" ? context.step.value : undefined;
  const expectedUrl = stepString(context.step, "url");
  const expectedCount = stepNumber(context.step, "count");
  if (
    visible === undefined &&
    expectedText === undefined &&
    expectedValue === undefined &&
    expectedUrl === undefined &&
    expectedCount === undefined
  ) {
    throw invalid(context, "assert 至少需要一个断言条件");
  }

  const selectorTarget = targetSelector(interpolatedTargetStep(context, false));
  const expected: Record<string, unknown> = {};
  const actual: Record<string, unknown> = {};
  const failures: string[] = [];

  try {
    if (visible !== undefined) {
      expected.visible = visible;
      const selector =
        typeof visible === "string" ? interpolate(visible, context.vars) : selectorTarget?.selector;
      const state: WaitState = visible === false ? "hidden" : "visible";
      if (!selector) throw invalid(context, "assert visible 缺少 selector");
      try {
        await context.driver.waitForSelector(selector, state, context.timeoutMs);
        actual.visible = state === "visible";
      } catch {
        actual.visible = state !== "visible";
        failures.push(`expected ${state}, got ${state === "hidden" ? "visible" : "hidden"}: ${selector}`);
      }
    }

    if (expectedText !== undefined) {
      expected.text = expectedText;
      const scope = selectorTarget?.selector;
      const found = await context.driver.evaluate<boolean>(`
(() => {
  const scope = ${JSON.stringify(scope ?? null)};
  const wanted = ${JSON.stringify(interpolate(expectedText, context.vars))};
  const host = scope ? document.querySelector(scope) : document.body;
  if (!host) return false;
  return (host.innerText || host.textContent || "").includes(wanted);
})()
`);
      actual.text = found;
      if (!found) failures.push(`text not found: ${expectedText}`);
    }

    if (expectedValue !== undefined) {
      expected.value = expectedValue;
      const wanted = interpolate(expectedValue, context.vars);
      const selector = selectorTarget?.selector;
      if (!selector) throw invalid(context, "assert value 缺少 selector");
      const value = await context.driver.evaluate<string | null>(`
(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return null;
  return typeof element.value === "string" ? element.value : null;
})()
`);
      actual.value = value;
      if (value !== wanted) failures.push(`value mismatch: expected ${wanted}, got ${String(value)}`);
    }

    if (expectedUrl !== undefined) {
      expected.url = expectedUrl;
      const url = await context.driver.url();
      actual.url = url;
      const wanted = interpolate(expectedUrl, context.vars);
      if (!url.includes(wanted)) failures.push(`url does not contain ${wanted}: ${url}`);
    }

    if (expectedCount !== undefined) {
      expected.count = expectedCount;
      const selector = selectorTarget?.selector;
      if (!selector) throw invalid(context, "assert count 缺少 selector");
      const count = await context.driver.evaluate<number>(
        `document.querySelectorAll(${JSON.stringify(selector)}).length`,
      );
      actual.count = count;
      if (count !== expectedCount) {
        failures.push(`count mismatch: expected ${expectedCount}, got ${count}`);
      }
    }
  } catch (error) {
    if (error instanceof DemoError && error.code === "E_SCENE_INVALID") throw error;
    failures.push(
      `assertion evaluation error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (failures.length === 0) {
    return { detail: "assert passed" };
  }

  const screenshotPath = path.join(context.screenshotDir, `step-${context.index}.png`);
  let screenshotError: string | undefined;
  try {
    await mkdir(context.screenshotDir, { recursive: true });
    await context.driver.screenshot(screenshotPath);
  } catch (error) {
    screenshotError = error instanceof Error ? error.message : String(error);
  }

  throw new DemoError("E_ASSERTION_FAILED", `断言失败：${failures.join("; ")}`, {
    sceneId: context.scene.id,
    stepIndex: context.index,
    selector: selectorTarget?.selector,
    screenshotPath: screenshotError ? undefined : screenshotPath,
    details: { expected, actual, failures, screenshotError },
  });
}

async function switchScene(context: ActionContext): Promise<ActionResult> {
  const sceneId = stepString(context.step, "scene_id", "sceneId");
  if (!sceneId) throw invalid(context, "scene 缺少 scene_id");
  if (!context.resolveScene) {
    throw new DemoError("E_SCENE_NOT_FOUND", `未配置场景解析器，无法切换场景：${sceneId}`, {
      sceneId,
      stepIndex: context.index,
    });
  }
  const scene = await context.resolveScene(sceneId);
  return { detail: `switch to scene ${scene.id}`, switchedScene: scene };
}

async function setVar(context: ActionContext): Promise<ActionResult> {
  const name = stepString(context.step, "name");
  const value = typeof context.step.value === "string" ? context.step.value : undefined;
  if (!name || value === undefined) throw invalid(context, "set 缺少 name 或 value");
  context.vars[name] = interpolate(value, context.vars);
  return { detail: `set ${name}` };
}

async function screenshot(context: ActionContext): Promise<ActionResult> {
  const relativePath = stepString(context.step, "path");
  if (!relativePath) throw invalid(context, "screenshot 缺少 path");
  const target = resolveScreenshotPath(context.screenshotDir, interpolate(relativePath, context.vars));
  await mkdir(path.dirname(target), { recursive: true });
  await context.driver.screenshot(target);
  return { detail: `screenshot ${target}` };
}

function interpolatedTargetStep(context: ActionContext, includeText: boolean): SceneStep {
  const step: SceneStep = { ...context.step };
  for (const key of ["data_demo_id", "dataDemoId", "selector", "target_text", "targetText"]) {
    const value = step[key];
    if (typeof value === "string") step[key] = interpolate(value, context.vars);
  }
  if (includeText && typeof step.text === "string") {
    step.text = interpolate(step.text, context.vars);
  }
  return step;
}

function invalid(context: ActionContext, message: string): DemoError {
  return new DemoError("E_SCENE_INVALID", message, {
    sceneId: context.scene.id,
    stepIndex: context.index,
  });
}

function waitState(step: SceneStep, fallback: WaitState): WaitState {
  const state = stepString(step, "state");
  if (state === undefined) return fallback;
  if (state === "visible" || state === "hidden" || state === "attached") return state;
  throw new DemoError("E_SCENE_INVALID", `wait_for state 非法：${state}`);
}

function clickButton(step: SceneStep): "left" | "middle" | "right" {
  const button = stepString(step, "button");
  if (button === undefined) return "left";
  if (button === "left" || button === "middle" || button === "right") return button;
  throw new DemoError("E_SCENE_INVALID", `click button 非法：${button}`);
}

function clickCountValue(step: SceneStep): number {
  const count = stepNumber(step, "click_count", "clickCount") ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new DemoError("E_SCENE_INVALID", `click_count 必须是正整数：${count}`);
  }
  return count;
}

function annotationPosition(step: SceneStep): "top" | "bottom" | "left" | "right" | undefined {
  const position = stepString(step, "position");
  if (position === undefined) return undefined;
  if (position === "top" || position === "bottom" || position === "left" || position === "right") {
    return position;
  }
  throw new DemoError("E_SCENE_INVALID", `annotate position 非法：${position}`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}


