import type { CdpPage, Rect } from "./cdp-page";

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
      ".cursor{position:fixed;left:0;top:0;transform:translate(-60px,-60px);pointer-events:none;transition:transform 160ms cubic-bezier(.2,.7,.3,1);}",
      ".cursor svg{display:block;filter:drop-shadow(0 2px 3px rgba(15,23,42,.45));}",
      ".ripple{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;",
      "background:radial-gradient(circle,rgba(37,99,235,.55),rgba(37,99,235,0));opacity:0;pointer-events:none;}",
      ".ripple.on{animation:demo-ripple 520ms ease-out;}",
      "@keyframes demo-ripple{0%{opacity:.95;transform:scale(.25);}100%{opacity:0;transform:scale(1.7);}}",
      ".highlight{position:fixed;border:3px solid #2563eb;border-radius:8px;box-shadow:0 0 0 3px rgba(37,99,235,.18);",
      "opacity:0;transition:opacity 160ms ease;pointer-events:none;}",
      ".highlight.on{opacity:1;}",
      "</style>",
      '<div class="cursor"><svg width="20" height="26" viewBox="0 0 20 26">',
      '<path d="M1 1 L19 13 L11 14.6 L14.4 24 L10.6 25.4 L7.2 16 L1 20.6 Z" fill="#ffffff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/>',
      "</svg></div>",
      '<div class="ripple"></div>',
      '<div class="highlight"></div>',
    ].join("");
    document.documentElement.appendChild(host);

    const shadowCursor = shadow.querySelector(".cursor");
    const shadowRipple = shadow.querySelector(".ripple");
    const shadowHighlight = shadow.querySelector(".highlight");
    let hideTimer = 0;

    const api = {
      move(x, y) {
        shadowCursor.style.transform = "translate(" + (x - 1) + "px," + (y - 1) + "px)";
      },
      click(x, y) {
        api.move(x, y);
        shadowRipple.style.left = x + "px";
        shadowRipple.style.top = y + "px";
        shadowRipple.classList.remove("on");
        void shadowRipple.offsetWidth;
        shadowRipple.classList.add("on");
      },
      highlight(rect, ms) {
        shadowHighlight.style.left = rect.left + "px";
        shadowHighlight.style.top = rect.top + "px";
        shadowHighlight.style.width = rect.width + "px";
        shadowHighlight.style.height = rect.height + "px";
        shadowHighlight.classList.add("on");
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => shadowHighlight.classList.remove("on"), ms || 1200);
      },
      clear() {
        shadowHighlight.classList.remove("on");
        shadowRipple.classList.remove("on");
      },
    };
    window.__maloBrowserOverlay = api;
  }
  return true;
})()
`;

declare global {
  interface Window {
    __maloBrowserOverlay?: {
      move(x: number, y: number): void;
      click(x: number, y: number): void;
      highlight(rect: { left: number; top: number; width: number; height: number }, ms: number): void;
      clear(): void;
    };
  }
}

export async function injectOverlay(page: CdpPage): Promise<void> {
  await page.evaluate<boolean>(OVERLAY_SCRIPT);
  await page.evaluate<boolean>("typeof window.__maloBrowserOverlay === 'object'");
}

export async function overlayMove(page: CdpPage, x: number, y: number): Promise<void> {
  await page.evaluate(`window.__maloBrowserOverlay.move(${x}, ${y})`);
}

export async function overlayClick(page: CdpPage, x: number, y: number): Promise<void> {
  await page.evaluate(`window.__maloBrowserOverlay.click(${x}, ${y})`);
}

export async function overlayHighlight(page: CdpPage, rect: Rect, ms: number): Promise<void> {
  await page.evaluate(
    `window.__maloBrowserOverlay.highlight({ left: ${rect.left}, top: ${rect.top}, width: ${rect.width}, height: ${rect.height} }, ${ms})`,
  );
}
