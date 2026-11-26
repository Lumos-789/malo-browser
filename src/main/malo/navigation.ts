import { DemoError } from "../../shared/errors";
import type { MaloLightObservation, MaloNavigationDiagnostics } from "../../shared/malo";
import { sleep } from "../tools";
import { observePage } from "./observation";
import type { SessionInternals } from "./session-internals";
import { withTimeout } from "./timeouts";

export function looksLikeChallengeUrl(url: string): boolean {
  return /(?:js_challenge|jsc_token|jsc_orig_r|\/(?:challenge|captcha|verify)(?:\/|$))/i.test(url);
}

export function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DemoError("E_NAV_BLOCKED", `无效 URL：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DemoError("E_NAV_BLOCKED", `只允许 http/https 导航：${raw}`);
  }
  if (url.username || url.password) {
    throw new DemoError("E_NAV_BLOCKED", "URL 不允许包含 credentials");
  }
  return url.toString();
}

export async function navigatePage(
  session: SessionInternals,
  rawUrl: string,
  timeoutMs: number,
  settleMs: number,
): Promise<MaloLightObservation> {
  session.assertOpen();
  const url = validateUrl(rawUrl);
  const boundedTimeout = Math.max(100, Math.min(120_000, Math.floor(timeoutMs)));
  const boundedSettle = Math.max(0, Math.min(15_000, Math.floor(settleMs)));
  session.touch();
  session.failedRequests.length = 0;
  session.consoleErrors.length = 0;
  session.navigationState = {
    requested_url: url,
    final_url: url,
    http_status: null,
    http_status_text: "",
    load_state: "timeout",
    net_error: null,
    net_error_description: null,
    navigations: 0,
    redirects: [],
    started_at: new Date().toISOString(),
    finished_at: null,
    settle: { waited_ms: 0, ready_state: "", dom_elements: 0, stable_samples: 0 },
  };
  session.record("navigation.started", { url });

  let loadError: unknown = null;
  try {
    await session.driver.navigate(url, { timeoutMs: boundedTimeout });
  } catch (error) {
    loadError = error;
  }

  const settle = await settleNavigation(session, boundedSettle);
  const wc = session.stage.view.webContents;
  const state = session.navigationState;
  state.final_url = wc.getURL() || state.final_url;
  state.finished_at = new Date().toISOString();
  state.settle = settle;

  const hardFailure =
    state.net_error !== null ||
    state.final_url.startsWith("chrome-error://") ||
    (loadError !== null && settle.dom_elements < 20);

  if (hardFailure) {
    state.load_state = state.net_error !== null || state.final_url.startsWith("chrome-error://")
      ? "failed"
      : "timeout";
    const screenshotPath = await session.captureFailure();
    const reason =
      state.net_error_description ??
      (loadError instanceof Error ? loadError.message : String(loadError ?? "页面未加载"));
    session.record("navigation.failed", {
      url,
      final_url: state.final_url,
      net_error: state.net_error,
      reason,
      screenshotPath,
    });
    throw new DemoError("E_NAV_FAILED", reason, {
      url,
      screenshotPath: screenshotPath ?? undefined,
      details: {
        navigation: state,
        failed_requests: session.failedRequests.slice(-5),
        console_errors: session.consoleErrors.slice(-5),
      },
    });
  }

  state.load_state = loadError ? "partial" : "complete";
  session.record("navigation.finished", {
    url,
    final_url: state.final_url,
    load_state: state.load_state,
  });
  const observation = await observePage(session, "light", 2_000);
  return { ...observation, navigation: state };
}

export async function settleNavigation(
  session: SessionInternals,
  maxMs: number,
): Promise<MaloNavigationDiagnostics["settle"]> {
  const started = Date.now();
  let lastUrl = "";
  let lastElements = -1;
  let stableSamples = 0;
  let lastChangeMs = started;
  let readyState = "";
  let domElements = 0;
  let lastNetworkIdleMs = session.driver.lastLifecycleAt("networkAlmostIdle") ?? 0;

  while (Date.now() - started < maxMs) {
    session.assertOpen();
    const stamp = await withTimeout(
      session.driver.evaluate<{ url: string; ready: string; elements: number }>(
        "({url: location.href, ready: document.readyState, elements: document.querySelectorAll('*').length})",
      ),
      800,
      "DOM 稳定采样超时",
    ).catch(() => null);
    if (stamp) {
      if (stamp.url !== lastUrl || stamp.elements !== lastElements) {
        lastUrl = stamp.url;
        lastElements = stamp.elements;
        lastChangeMs = Date.now();
        stableSamples = 0;
      } else {
        stableSamples += 1;
      }
      readyState = stamp.ready;
      domElements = stamp.elements;
    }
    lastNetworkIdleMs = Math.max(
      lastNetworkIdleMs,
      session.driver.lastLifecycleAt("networkAlmostIdle") ?? 0,
    );
    const elapsed = Date.now() - started;
    const quietFor = Date.now() - Math.max(lastChangeMs, lastNetworkIdleMs, started);
    const challenge = looksLikeChallengeUrl(lastUrl);
    const readyEnough = readyState === "complete" || readyState === "interactive";
    if (elapsed >= 400 && quietFor >= 600 && readyEnough && (!challenge || domElements > 50)) {
      break;
    }
    if (elapsed >= 1_500 && readyState === "complete" && stableSamples >= 10) break;
    await sleep(100);
  }

  return {
    waited_ms: Date.now() - started,
    ready_state: readyState,
    dom_elements: domElements,
    stable_samples: stableSamples,
  };
}
