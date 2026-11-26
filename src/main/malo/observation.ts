import { DemoError } from "../../shared/errors";
import type { MaloLightObservation, MaloObservation } from "../../shared/malo";
import type { SessionInternals } from "./session-internals";

export async function observePage(
  session: SessionInternals,
  mode: "light" | "screenshot",
  maxChars = 2_000,
  clipSelector?: string,
): Promise<MaloObservation> {
  session.assertOpen();
  session.touch();
  const requested = Number.isFinite(maxChars) ? Math.floor(maxChars) : 2_000;
  const limit = Math.max(0, Math.min(20_000, requested));
  const base = await session.driver.evaluate<MaloLightObservation>(`(() => {
    const body = document.body;
    const text = (body && body.innerText ? body.innerText : "").replace(/\\s+/g, " ").trim();
    return {
      url: location.href,
      title: document.title || "",
      ready_state: document.readyState,
      loading: false,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      dom: {
        elements: document.querySelectorAll("*").length,
        interactive: document.querySelectorAll('a,button,input,select,textarea,[role="button"],[contenteditable="true"]').length,
        text_length: text.length
      },
      body_text: text.slice(0, ${JSON.stringify(limit)}),
      runtime: {
        user_agent: navigator.userAgent,
        webdriver: navigator.webdriver === true,
        online: navigator.onLine,
        visibility_state: document.visibilityState,
        hardware_concurrency: navigator.hardwareConcurrency || 0
      }
    };
  })()`);
  base.loading = session.stage.view.webContents.isLoading();
  base.navigation = session.navigationState ? { ...session.navigationState } : undefined;
  base.network = {
    failed_requests: session.failedRequests.length,
    failures: session.failedRequests.slice(-5),
    console_errors: session.consoleErrors.slice(-5),
  };
  if (mode === "light") return base;
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  let clipRect: { x: number; y: number; width: number; height: number } | undefined;
  if (clipSelector !== undefined) {
    if (typeof clipSelector !== "string" || clipSelector.trim() === "") {
      throw new DemoError("E_BAD_REQUEST", "clip_selector 必须是非空字符串");
    }
    const measured = await session.driver.evaluate<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(clipSelector)});
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      // clip 用文档坐标：视口矩形 + 滚动偏移
      return {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    })()`);
    if (!measured) {
      throw new DemoError("E_SELECTOR_NOT_FOUND", `找不到可截图元素 ${clipSelector}`, {
        details: { selector: clipSelector },
      });
    }
    clipRect = measured;
    clip = { ...measured, scale: 1 };
  }
  const shot = await session.driver.send<{ data: string }>("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    ...(clip ? { clip } : {}),
  });
  session.record("observe.screenshot", {
    bytes: Buffer.byteLength(shot.data, "base64"),
    clip: clipRect ?? null,
  });
  return {
    ...base,
    screenshot: { mime_type: "image/png", base64: shot.data },
    ...(clipRect ? { screenshot_clip: { selector: clipSelector, ...clipRect } } : {}),
  };
}
