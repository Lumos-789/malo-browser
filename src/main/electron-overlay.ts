import type { Point, Rect } from "../shared/types";
import type { AnnotateOptions, MaskOptions, OverlayPort, SpotlightOptions } from "./core/ports";
import type { ElectronPageDriver } from "./electron-page-driver";

const OVERLAY_SCRIPT = String.raw`
(() => {
  const HOST_ID = "__malo_browser_overlay_host__";
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = [
      "<style>",
      ".cursor{position:fixed;left:0;top:0;transform:translate(-60px,-60px);transition:transform 160ms cubic-bezier(.2,.7,.3,1);}",
      ".cursor svg{display:block;filter:drop-shadow(0 2px 3px rgba(15,23,42,.45));}",
      ".ripple{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;",
      "background:radial-gradient(circle,rgba(37,99,235,.55),rgba(37,99,235,0));opacity:0;}",
      ".ripple.on{animation:demo-ripple 520ms ease-out;}",
      "@keyframes demo-ripple{0%{opacity:.95;transform:scale(.25);}100%{opacity:0;transform:scale(1.7);}}",
      ".highlight{position:fixed;border:3px solid #2563eb;border-radius:8px;box-shadow:0 0 0 3px rgba(37,99,235,.18);opacity:0;transition:opacity 160ms ease;}",
      ".highlight.on{opacity:1;}",
      ".spotlight{position:fixed;border-radius:10px;box-shadow:0 0 0 9999px rgba(2,6,23,.55);opacity:0;transition:opacity 160ms ease;}",
      ".spotlight.on{opacity:1;}",
      ".annotate{position:fixed;max-width:360px;padding:8px 12px;border-radius:6px;background:#0f172a;color:#fff;",
      "font:500 13px/1.5 -apple-system,'PingFang SC',sans-serif;opacity:0;transform:translateY(4px);transition:opacity 160ms ease,transform 160ms ease;}",
      ".annotate.on{opacity:1;transform:translateY(0);}",
      ".mask{position:fixed;backdrop-filter:blur(10px);background:rgba(255,255,255,.08);border-radius:6px;opacity:0;transition:opacity 160ms ease;}",
      ".mask.on{opacity:1;}",
      ".blackout{position:fixed;inset:0;background:#000;opacity:0;transition:opacity 220ms ease;}",
      ".blackout.on{opacity:1;}",
      "</style>",
      '<div class="spotlight"></div>',
      '<div class="mask"></div>',
      '<div class="blackout"></div>',
      '<div class="cursor"><svg width="20" height="26" viewBox="0 0 20 26">',
      '<path d="M1 1 L19 13 L11 14.6 L14.4 24 L10.6 25.4 L7.2 16 L1 20.6 Z" fill="#ffffff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/>',
      "</svg></div>",
      '<div class="ripple"></div>',
      '<div class="annotate"></div>',
      '<div class="highlight"></div>',
    ].join("");
    document.documentElement.appendChild(host);

    const cursor = shadow.querySelector(".cursor");
    const ripple = shadow.querySelector(".ripple");
    const highlight = shadow.querySelector(".highlight");
    const spotlight = shadow.querySelector(".spotlight");
    const annotate = shadow.querySelector(".annotate");
    const mask = shadow.querySelector(".mask");
    const blackout = shadow.querySelector(".blackout");
    const timers = new Map();

    const later = (key, fn, ms) => {
      clearTimeout(timers.get(key));
      if (ms > 0) timers.set(key, setTimeout(fn, ms));
    };
    const place = (el, rect) => {
      el.style.left = rect.left + "px";
      el.style.top = rect.top + "px";
      el.style.width = rect.width + "px";
      el.style.height = rect.height + "px";
    };

    window.__maloBrowserOverlay = {
      move(x, y) {
        cursor.style.transform = "translate(" + (x - 1) + "px," + (y - 1) + "px)";
      },
      click(x, y) {
        this.move(x, y);
        ripple.style.left = x + "px";
        ripple.style.top = y + "px";
        ripple.classList.remove("on");
        void ripple.offsetWidth;
        ripple.classList.add("on");
      },
      highlight(rect, seconds, color) {
        place(highlight, rect);
        highlight.style.borderColor = color || "#2563eb";
        highlight.classList.add("on");
        later("highlight", () => highlight.classList.remove("on"), (seconds || 1.2) * 1000);
      },
      spotlight(rect, options) {
        const padding = (options && options.padding) || 8;
        place(spotlight, { left: rect.left - padding, top: rect.top - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 });
        spotlight.style.boxShadow = "0 0 0 9999px rgba(2,6,23," + ((options && options.dim) || 0.55) + ")";
        spotlight.classList.add("on");
        later("spotlight", () => spotlight.classList.remove("on"), ((options && options.seconds) || 2) * 1000);
      },
      annotate(rect, options) {
        annotate.textContent = options.text;
        const position = (options && options.position) || "top";
        const width = annotate.offsetWidth || 0;
        const height = annotate.offsetHeight || 0;
        let left = rect.left;
        let top = rect.top - height - 8;
        if (position === "bottom") top = rect.top + rect.height + 8;
        else if (position === "left") { left = rect.left - width - 8; top = rect.top; }
        else if (position === "right") { left = rect.left + rect.width + 8; top = rect.top; }
        annotate.style.left = Math.max(8, left) + "px";
        annotate.style.top = Math.max(8, top) + "px";
        annotate.classList.add("on");
        later("annotate", () => annotate.classList.remove("on"), ((options && options.seconds) || 2.4) * 1000);
      },
      mask(rect, options) {
        place(mask, rect);
        mask.style.background = (options && options.mode === "solid") ? ((options && options.color) || "#111") : "rgba(255,255,255,.08)";
        mask.classList.add("on");
      },
      blackout(on) {
        blackout.classList.toggle("on", !!on);
      },
      clear() {
        [highlight, spotlight, annotate, mask].forEach((el) => el.classList.remove("on"));
        blackout.classList.remove("on");
        ripple.classList.remove("on");
      },
    };
  }
  return true;
})()
`;

export class ElectronOverlay implements OverlayPort {
  constructor(private readonly page: ElectronPageDriver) {}

  async inject(): Promise<void> {
    await this.page.evaluate<boolean>(OVERLAY_SCRIPT);
  }

  /**
   * Any navigation replaces the document and drops the overlay. Every visual
   * operation re-checks presence and re-injects, so a scene keeps working after
   * `goto`/`login` or a page-initiated navigation.
   */
  private async ensure(): Promise<void> {
    const present = await this.page.evaluate<boolean>("Boolean(window.__maloBrowserOverlay)");
    if (!present) await this.inject();
  }

  async move(point: Point): Promise<void> {
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.move(${point.x}, ${point.y})`);
  }

  async click(point: Point): Promise<void> {
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.click(${point.x}, ${point.y})`);
  }

  async highlight(rect: Rect, seconds = 1.2, color?: string): Promise<void> {
    const json = JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.highlight(${json}, ${seconds}, ${JSON.stringify(color ?? null)})`);
  }

  async spotlight(rect: Rect, options: SpotlightOptions = {}): Promise<void> {
    const box = JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.spotlight(${box}, ${JSON.stringify(options)})`);
  }

  async annotate(rect: Rect, options: AnnotateOptions): Promise<void> {
    const box = JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.annotate(${box}, ${JSON.stringify(options)})`);
  }

  async mask(rect: Rect, options: MaskOptions = {}): Promise<void> {
    const box = JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.mask(${box}, ${JSON.stringify(options)})`);
  }

  async blackout(on: boolean): Promise<void> {
    await this.ensure();
    await this.page.evaluate(`window.__maloBrowserOverlay.blackout(${on})`);
  }

  async clear(): Promise<void> {
    await this.ensure();
    await this.page.evaluate("window.__maloBrowserOverlay.clear()");
  }
}
