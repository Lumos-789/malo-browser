import type { WebContents } from "electron";
import { sleep } from "./tools";

export type Rect = {
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
};

type EvaluateResult<T> = {
  result: { value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

export class CdpPage {
  constructor(private readonly wc: WebContents) {}

  async attach(options: { focusEmulation?: boolean } = {}): Promise<void> {
    try {
      this.wc.debugger.attach("1.3");
    } catch (error) {
      throw new Error(`E_CDP_ATTACH_FAILED: ${(error as Error).message}`);
    }
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    if (options.focusEmulation) {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    }
  }

  detach(): void {
    if (this.wc.debugger.isAttached()) this.wc.debugger.detach();
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.wc.debugger.sendCommand(method, params)) as T;
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
      throw new Error(`页面脚本执行失败：${detail.split("\n")[0]}`);
    }
    return result.result.value as T;
  }

  async waitFor(selector: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate<boolean>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`,
      );
      if (found) return;
      await sleep(100);
    }
    throw new Error(`E_SELECTOR_NOT_FOUND: ${timeoutMs}ms 内找不到可见元素 ${selector}`);
  }

  async rect(selector: string): Promise<Rect> {
    const rect = await this.evaluate<Rect | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height }; })()`,
    );
    if (!rect) throw new Error(`E_SELECTOR_NOT_FOUND: 找不到元素 ${selector}`);
    return rect;
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
  }

  async click(x: number, y: number): Promise<void> {
    await this.mouseMove(x, y);
    await sleep(70);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await sleep(50);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  async clickSelector(selector: string): Promise<Rect> {
    const rect = await this.rect(selector);
    await this.click(rect.x, rect.y);
    return rect;
  }

  async pressKey(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
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
    await this.pressKey("a", "KeyA", 65, 4);
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async screenshot(path: string): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await writeFile(path, Buffer.from(shot.data, "base64"));
  }

  async viewport(): Promise<{ width: number; height: number; dpr: number }> {
    return this.evaluate<{ width: number; height: number; dpr: number }>(
      "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
    );
  }

  async nodeExposed(): Promise<boolean> {
    return this.evaluate<boolean>(
      "typeof window.require !== 'undefined' || typeof window.process !== 'undefined' || typeof window.module !== 'undefined'",
    );
  }
}
