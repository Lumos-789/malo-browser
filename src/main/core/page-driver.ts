import type { Point, Rect } from "../../shared/types";

export type WaitState = "attached" | "visible" | "hidden";

export type ClickOptions = {
  button?: "left" | "middle" | "right";
  clickCount?: number;
};

/**
 * Everything the Runner may do to a page. Implementations must not expose
 * Electron types, so a CEF driver can replace the Electron one later.
 */
export interface PageDriver {
  navigate(url: string, options?: { timeoutMs?: number }): Promise<void>;
  waitForSelector(selector: string, state: WaitState, timeoutMs: number): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<void>;
  waitForUrl(contains: string, timeoutMs: number): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  rect(selector: string): Promise<Rect>;
  url(): Promise<string>;
  move(point: Point): Promise<void>;
  click(point: Point, options?: ClickOptions): Promise<void>;
  insertText(text: string): Promise<void>;
  press(key: string, modifiers?: number): Promise<void>;
  selectAll(): Promise<void>;
  scroll(delta: Point): Promise<void>;
  screenshot(path: string): Promise<void>;
}
