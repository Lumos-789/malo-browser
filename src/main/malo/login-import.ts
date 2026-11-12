import type { Session } from "electron";
import { DemoError } from "../../shared/errors";
import type { MaloProfileImportInput, MaloProfileImportResult } from "../../shared/malo";

/** CDP Storage.getCookies 返回的 cookie（只列本模块用到的字段）。 */
export type CdpCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function validateCdpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DemoError("E_BAD_REQUEST", `cdp_url 无效：${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new DemoError("E_BAD_REQUEST", `cdp_url 只允许 http（本机 CDP 端点）：${raw}`);
  }
  assertLoopbackHost(url, "cdp_url", raw);
  return url;
}

function assertLoopbackHost(url: URL, what: string, raw: string): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DemoError(
      "E_BAD_REQUEST",
      `${what} 只允许回环地址（127.0.0.1 / localhost / ::1），拒绝：${raw}`,
    );
  }
}

// /json/version 返回的 webSocketDebuggerUrl 来自源端点，不能默认它仍指向回环：
// 连接前与 cdp_url 同口径复核，否则非回环地址会从这跳绕开安全边界。
function assertWsUrlLoopback(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DemoError("E_BAD_REQUEST", `webSocketDebuggerUrl 无效：${raw}`);
  }
  assertLoopbackHost(url, "webSocketDebuggerUrl", raw);
}

function domainMatches(cookieDomain: string, wanted: string): boolean {
  const cd = cookieDomain.toLowerCase().replace(/^\./, "");
  const w = wanted.toLowerCase().replace(/^\./, "");
  return cd === w || cd.endsWith(`.${w}`) || w.endsWith(`.${cd}`);
}

export function matchesDomains(domain: string, domains?: string[]): boolean {
  if (!domains || domains.length === 0) return true;
  return domains.some((wanted) => domainMatches(domain, wanted));
}

const SAME_SITE_MAP: Record<
  string,
  "unspecified" | "no_restriction" | "lax" | "strict"
> = {
  Strict: "strict",
  Lax: "lax",
  None: "no_restriction",
};

export function cookieToDetails(
  cookie: CdpCookie,
  nowSec: number,
  sessionTtlDays: number,
): Electron.CookiesSetDetails {
  const host = cookie.domain.replace(/^\./, "");
  const path = cookie.path || "/";
  const details: Electron.CookiesSetDetails = {
    url: `${cookie.secure ? "https" : "http"}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    path,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
  };
  // CDP 约定：domain 带前导点 = 可共享子域的 domain cookie；不带 = host-only。
  // host-only 不传 domain 参数，Electron 以 url 的 host 落 cookie。
  if (cookie.domain.startsWith(".")) {
    details.domain = cookie.domain;
  }
  const sameSite = SAME_SITE_MAP[cookie.sameSite ?? ""];
  if (sameSite) details.sameSite = sameSite;
  const isSession = cookie.session === true || !cookie.expires || cookie.expires <= 0;
  if (isSession) {
    // session cookie 只活在内存里，daemon 一退就丢；默认固化成持久 cookie，
    // 保住导入的登录态（源 Chrome 重启后 session cookie 同样消失，届时重导即可）。
    if (sessionTtlDays > 0) details.expirationDate = nowSec + sessionTtlDays * 86_400;
  } else {
    details.expirationDate = cookie.expires;
  }
  return details;
}

async function fetchCdpCookies(rawUrl: string, timeoutMs = 10_000): Promise<CdpCookie[]> {
  const url = validateCdpUrl(rawUrl);
  const base = `${url.protocol}//${url.host}`;
  let wsUrl: string | undefined;
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const version = (await res.json()) as { webSocketDebuggerUrl?: string };
    wsUrl = version.webSocketDebuggerUrl;
  } catch (error) {
    throw new DemoError(
      "E_IMPORT_SOURCE_UNREACHABLE",
      `连不上源 CDP ${base}/json/version：${(error as Error).message}`,
    );
  }
  if (!wsUrl) {
    throw new DemoError("E_IMPORT_SOURCE_UNREACHABLE", `源 CDP ${base} 未返回 webSocketDebuggerUrl`);
  }
  assertWsUrlLoopback(wsUrl);
  return await new Promise<CdpCookie[]>((resolve, reject) => {
    const ws = new WebSocket(wsUrl as string);
    const fail = (message: string) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // close 在未连接时抛错可忽略
      }
      reject(new DemoError("E_IMPORT_SOURCE_UNREACHABLE", message));
    };
    const timer = setTimeout(
      () => fail(`源 CDP ${base} Storage.getCookies 超时（${timeoutMs}ms）`),
      timeoutMs,
    );
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    ws.onmessage = (event) => {
      // 坏帧（非 JSON 文本帧或二进制帧）只废掉本次 import，不允许异常
      // 漏出回调把整个 daemon 带下桌。
      let msg: {
        id?: number;
        result?: { cookies?: CdpCookie[] };
        error?: { message?: string };
      };
      try {
        if (typeof event.data !== "string") {
          throw new Error(`非文本帧（${typeof event.data}）`);
        }
        msg = JSON.parse(event.data);
      } catch (error) {
        fail(`源 CDP ${base} Storage.getCookies 帧无法解析：${(error as Error).message}`);
        return;
      }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // 同上
      }
      if (msg.error) {
        reject(new DemoError("E_IMPORT_SOURCE_UNREACHABLE", `源 CDP 返回错误：${msg.error.message}`));
        return;
      }
      resolve(msg.result?.cookies ?? []);
    };
    ws.onerror = () => fail(`源 CDP WebSocket 连接失败：${wsUrl}`);
  });
}

const MAX_REPORTED_FAILURES = 20;

async function writeCookiesToPartition(
  partition: Session,
  cookies: CdpCookie[],
  sessionTtlDays: number,
  concurrency = 20,
): Promise<{ written: number; failed: MaloProfileImportResult["failed"] }> {
  const nowSec = Date.now() / 1000;
  let written = 0;
  const failed: MaloProfileImportResult["failed"] = [];
  for (let i = 0; i < cookies.length; i += concurrency) {
    const batch = cookies.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((cookie) => partition.cookies.set(cookieToDetails(cookie, nowSec, sessionTtlDays))),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        written += 1;
      } else if (failed.length < MAX_REPORTED_FAILURES) {
        failed.push({
          name: batch[index].name,
          domain: batch[index].domain,
          error: String((result.reason as Error)?.message ?? result.reason),
        });
      }
    }
  }
  return { written, failed };
}

export async function importLoginState(
  partition: Session,
  input: MaloProfileImportInput,
): Promise<Omit<MaloProfileImportResult, "profile" | "created">> {
  const all = await fetchCdpCookies(input.cdp_url);
  const matched = all.filter((cookie) => matchesDomains(cookie.domain, input.domains));
  if (matched.length === 0) {
    const scope = input.domains?.length ? `（域过滤 ${input.domains.join(", ")}）` : "";
    throw new DemoError(
      "E_IMPORT_EMPTY",
      `源 CDP ${input.cdp_url} 共 ${all.length} 条 cookie，域过滤后 0 条${scope}——源浏览器没有可导入的登录态`,
    );
  }
  const { written, failed } = await writeCookiesToPartition(
    partition,
    matched,
    input.session_cookie_ttl_days ?? 180,
  );
  return {
    source: input.cdp_url,
    cookies_total: all.length,
    cookies_matched: matched.length,
    cookies_written: written,
    cookies_failed: failed.length,
    failed,
  };
}
