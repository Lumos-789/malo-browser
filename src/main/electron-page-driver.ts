import type { WebContents } from "electron";
import { DemoError } from "../shared/errors";
import type { Point, Rect } from "../shared/types";
import type { ClickOptions, PageDriver, WaitState } from "./core/page-driver";
import { sleep } from "./tools";

type EvaluateResult<T> = {
  result: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

export class ElectronPageDriver implements PageDriver {
  private readonly lifecycleAtMs = new Map<string, number>();
  private readonly onDebuggerMessage = (
    _event: unknown,
    method: string,
    params: { name?: string },
  ): void => {
    if (method === "Page.lifecycleEvent" && typeof params?.name === "string") {
      this.lifecycleAtMs.set(params.name, Date.now());
    }
  };

  constructor(private readonly wc: WebContents) {
    this.wc.debugger.on("message", this.onDebuggerMessage);
  }

  async attach(): Promise<void> {
    if (this.wc.debugger.isAttached()) return;
    const debug = (message: string) => {
      if (process.env.DEMO_DEBUG) console.error(`[malo] ${message}`);
    };
    debug("cdp: attaching");
    try {
      this.wc.debugger.attach("1.3");
    } catch (error) {
      throw new DemoError("E_CDP_ATTACH_FAILED", (error as Error).message);
    }
    debug("cdp: Page.enable");
    await this.send("Page.enable");
    debug("cdp: Runtime.enable");
    await this.send("Runtime.enable");
    debug("cdp: focus emulation");
    await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    try {
      await this.send("Page.setLifecycleEventsEnabled", { enabled: true });
    } catch {
      // Lifecycle events are an optimization for settling; DOM polling still works.
    }
    debug("cdp: ready");
  }

  detach(): void {
    this.wc.debugger.off("message", this.onDebuggerMessage);
    if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
  }

  lastLifecycleAt(name: string): number | undefined {
    return this.lifecycleAtMs.get(name);
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.wc.debugger.sendCommand(method, params)) as T;
  }

  async navigate(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 20000;
    try {
      await Promise.race([
        this.wc.loadURL(url),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new DemoError("E_STEP_TIMEOUT", `${timeoutMs}ms 内页面未加载完成`, { url })), timeoutMs),
        ),
      ]);
    } catch (error) {
      if (process.env.DEMO_DEBUG) console.error(`[malo-browser] loadURL 失败：${(error as Error).stack}`);
      throw error;
    }
  }

  async waitForDocumentReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.evaluate<string>("document.readyState");
      if (state === "complete") return;
      await sleep(100);
    }
    throw new DemoError("E_STEP_TIMEOUT", `${timeoutMs}ms 内页面未 ready`, { url: this.wc.getURL() });
  }

  async waitForSelector(selector: string, state: WaitState, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible = style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      return ${JSON.stringify(state)} === "attached" ? true : ${JSON.stringify(state)} === "visible" ? visible : !visible;
    })()`;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(expression)) return;
      await sleep(100);
    }
    throw new DemoError("E_STEP_TIMEOUT", `${timeoutMs}ms 内元素未达到 ${state}：${selector}`, {
      selector,
      url: this.wc.getURL(),
    });
  }

  async waitForText(text: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const expression = `document.body && document.body.innerText.includes(${JSON.stringify(text)})`;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(expression)) return;
      await sleep(100);
    }
    throw new DemoError("E_STEP_TIMEOUT", `${timeoutMs}ms 内页面未出现文本「${text}」`, { url: this.wc.getURL() });
  }

  async waitForUrl(contains: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.wc.getURL().includes(contains)) return;
      await sleep(100);
    }
    throw new DemoError("E_STEP_TIMEOUT", `${timeoutMs}ms 内 URL 未包含 ${contains}`, { url: this.wc.getURL() });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<EvaluateResult<T>>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "未知异常";
      throw new DemoError("E_STEP_TIMEOUT", `页面脚本执行失败：${detail.split("\n")[0]}`);
    }
    return result.result.value as T;
  }

  async rect(selector: string): Promise<Rect> {
    const rect = await this.evaluate<Rect | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
    );
    if (!rect) throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到元素 ${selector}`, { selector, url: this.wc.getURL() });
    return rect;
  }

  async url(): Promise<string> {
    return this.wc.getURL();
  }

  async move(point: Point): Promise<void> {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
  }

  async click(point: Point, options: ClickOptions = {}): Promise<void> {
    const button = options.button ?? "left";
    const clickCount = options.clickCount ?? 1;
    await this.move(point);
    await sleep(70);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button,
      buttons: 1,
      clickCount,
    });
    await sleep(50);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button,
      buttons: 0,
      clickCount,
    });
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async press(key: string, modifiers = 0): Promise<void> {
    // CDP Meta key events fall through to the macOS application menu and can
    // open the native About panel. Route the common editing shortcuts through
    // WebContents commands instead of synthesizing a system-level chord.
    if ((modifiers & 4) !== 0) {
      const shift = (modifiers & 8) !== 0;
      const normalized = key.toLowerCase();
      if (normalized === "a" && !shift) return this.wc.selectAll();
      if (normalized === "c" && !shift) return this.wc.copy();
      if (normalized === "v" && !shift) return this.wc.paste();
      if (normalized === "x" && !shift) return this.wc.cut();
      if (normalized === "z") return shift ? this.wc.redo() : this.wc.undo();
      throw new DemoError("E_UNSUPPORTED", `暂不支持 Meta 组合键 ${key}，请改用明确的编辑动作`);
    }
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const keyCode = key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
    });
  }

  async selectAll(): Promise<void> {
    await this.press("a", 4);
  }

  async scroll(delta: Point): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 10,
      y: 10,
      deltaX: delta.x,
      deltaY: delta.y,
    });
  }

  async screenshot(file: string): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(shot.data, "base64"));
  }
}
