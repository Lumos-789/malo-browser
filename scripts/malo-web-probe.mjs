#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const SITES = [
  { name: "example", url: "https://example.com/", tags: ["baseline"] },
  { name: "mdn", url: "https://developer.mozilla.org/en-US/", tags: ["docs", "js"] },
  { name: "github", url: "https://github.com/", tags: ["spa", "js"] },
  { name: "baidu", url: "https://www.baidu.com/", tags: ["search", "cn"] },
  { name: "zhihu", url: "https://www.zhihu.com/", tags: ["qa", "cn", "login"] },
  { name: "taobao", url: "https://www.taobao.com/", tags: ["commerce", "cn", "anti-bot"] },
  { name: "bilibili", url: "https://www.bilibili.com/", tags: ["video", "cn", "js"] },
  { name: "reddit", url: "https://www.reddit.com/", tags: ["social", "cloudflare"] },
  { name: "threejs", url: "https://threejs.org/examples/", tags: ["webgl", "canvas"] },
  { name: "osm", url: "https://www.openstreetmap.org/", tags: ["map", "tiles"] },
  { name: "gov-cn", url: "https://www.gov.cn/", tags: ["static", "cn"] },
  { name: "nytimes", url: "https://www.nytimes.com/", tags: ["news", "paywall", "anti-bot"] },
];

const BROKER_FILE = process.env.MALO_BROKER_FILE ?? process.env.HOME + "/.malo-browser/broker.json";
const OUT_ROOT = process.env.MALO_PROBE_OUT ?? path.resolve("evidence/malo-web-probe");
const INTERVAL_MS = Number(process.env.MALO_PROBE_INTERVAL_MS ?? "8000");
const TIMEOUT_MS = Number(process.env.MALO_PROBE_TIMEOUT_MS ?? "25000");
const SETTLE_MS = Number(process.env.MALO_PROBE_SETTLE_MS ?? "6000");
const ONLY = new Set(
  (process.env.MALO_PROBE_ONLY ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const CHALLENGE_MARKERS = [
  [/just a moment/i, "cloudflare-challenge"],
  [/attention required/i, "cloudflare-block"],
  [/checking your browser/i, "browser-check"],
  [/verify you are human/i, "human-verification"],
  [/unusual traffic/i, "unusual-traffic"],
  [/access denied/i, "access-denied"],
  [/request blocked/i, "request-blocked"],
  [/\bcaptcha\b/i, "captcha"],
  [/cf-error|cloudflare ray id/i, "cloudflare"],
  [/安全验证|人机验证|滑动验证|请完成验证|环境异常/, "cn-verification"],
  [/图形验证码|拖动滑块|滑块验证/, "captcha-cn"],
  [/向右滑动|我不是机器人|确认此网页操作行为/, "cn-human-check"],
  [/访问受限|请求过于频繁|访问异常/, "cn-access-restricted"],
];

const LOGIN_MARKERS = [
  [/扫码登录|登录后查看|请先登录|账号登录/, "login-wall"],
  [/\b(sign in|log in)\b/i, "login-link"],
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(base, pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(base + pathname, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON error pages are reported through status + text
  }
  return { status: response.status, json, text };
}

function brokerCall(broker, pathname, options = {}) {
  return requestJson(broker.endpoint, pathname, {
    ...options,
    headers: { "x-malo-broker-token": broker.token, ...options.headers },
  });
}

function leaseCall(lease, pathname, options = {}) {
  return requestJson(lease.endpoint, pathname, {
    ...options,
    headers: { "x-malo-lease-token": lease.token, ...options.headers },
  });
}

function sessionCall(lease, session, pathname, options = {}) {
  return leaseCall(lease, pathname, {
    ...options,
    headers: { "x-malo-session-token": session.session_token, ...options.headers },
  });
}

function analyzePng(buffer) {
  const png = PNG.sync.read(buffer);
  let sum = 0;
  let sumSq = 0;
  let nonWhite = 0;
  let dark = 0;
  let samples = 0;
  const colors = new Set();
  const step = 4;
  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const index = (png.width * y + x) << 2;
      const r = png.data[index];
      const g = png.data[index + 1];
      const b = png.data[index + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += luminance;
      sumSq += luminance * luminance;
      if (luminance < 245) nonWhite += 1;
      if (luminance < 80) dark += 1;
      colors.add((r << 16) | (g << 8) | b);
      samples += 1;
    }
  }
  const mean = sum / samples;
  const variance = Math.max(0, sumSq / samples - mean * mean);
  return {
    width: png.width,
    height: png.height,
    mean_luminance: Number(mean.toFixed(2)),
    stddev_luminance: Number(Math.sqrt(variance).toFixed(2)),
    non_white_ratio: Number((nonWhite / samples).toFixed(4)),
    dark_ratio: Number((dark / samples).toFixed(4)),
    sampled_unique_colors: colors.size,
  };
}

function detectMarkers(text, title, finalUrl) {
  const haystack = `${title}\n${text}`;
  const challenge = CHALLENGE_MARKERS.filter(([pattern]) => pattern.test(haystack)).map(
    ([, label]) => label,
  );
  const login = LOGIN_MARKERS.filter(([pattern]) => pattern.test(haystack)).map(
    ([, label]) => label,
  );
  const loginHint = /\/login|\/signin|\/passport/i.test(finalUrl) ? ["url-login"] : [];
  const challengeHint =
    /js_challenge|jsc_token|\/challenge|\/captcha|verify/i.test(finalUrl) &&
    haystack.trim().length < 800
    ? ["url-challenge"]
    : [];
  return {
    challenge: [...new Set([...challenge, ...challengeHint])],
    login: [...new Set([...login, ...loginHint])],
  };
}

function classify(result, screenshot) {
  if (result.login.includes("login-wall") || result.login.includes("url-login")) return "login-wall";
  if (result.challenge.length > 0) return "challenge";
  if (result.error) {
    if (result.navigation?.net_error) return "network-error";
    if (result.navigation?.load_state === "timeout") return "timeout";
    return "error";
  }
  if (result.http_status === 403 || result.http_status === 429) {
    return screenshot && screenshot.non_white_ratio > 0.01 ? "challenge" : "http-error";
  }
  if (result.http_status && result.http_status >= 400) return "http-error";
  if (!screenshot) return "partial";
  if (
    screenshot.stddev_luminance < 2 ||
    screenshot.non_white_ratio < 0.005 ||
    result.observation.dom.elements < 20
  ) {
    return "blank";
  }
  return "ok";
}

const broker = JSON.parse(await readFile(BROKER_FILE, "utf8"));
const health = await requestJson(broker.endpoint, "/health");
if (health.status !== 200) throw new Error(`malo-browser broker health 失败：${health.status} ${health.text}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(OUT_ROOT, stamp);
await mkdir(outDir, { recursive: true });

const lease = (
  await brokerCall(broker, "/v1/leases", {
    method: "POST",
    body: { agent_id: `web-probe-${stamp}` },
  })
).json;
if (!lease) throw new Error("无法创建 malo-browser probe lease");

const selected = SITES.filter((site) => ONLY.size === 0 || ONLY.has(site.name));
const report = {
  started_at: new Date().toISOString(),
  broker: broker.endpoint,
  lease_id: lease.lease_id,
  settings: {
    interval_ms: INTERVAL_MS,
    timeout_ms: TIMEOUT_MS,
    settle_ms: SETTLE_MS,
    sites: selected.length,
  },
  sites: [],
};

console.log(
  `probe ${selected.length} sites, interval=${INTERVAL_MS}ms, timeout=${TIMEOUT_MS}ms, out=${outDir}`,
);

for (let index = 0; index < selected.length; index += 1) {
  const site = selected[index];
  const started = Date.now();
  let session = null;
  const record = {
    name: site.name,
    url: site.url,
    tags: site.tags,
    status: "error",
    http_status: null,
    navigation: null,
    runtime: null,
    network: null,
    final_url: null,
    title: "",
    duration_ms: 0,
    observation: null,
    screenshot: null,
    screenshot_path: null,
    challenge: [],
    login: [],
    error: null,
  };

  try {
    const created = await leaseCall(lease, "/v1/sessions", {
      method: "POST",
      body: { name: `probe-${site.name}`, width: 1440, height: 900 },
    });
    if (created.status !== 201) throw new Error(`创建 session 失败：${created.status} ${created.text}`);
    session = created.json;

    const navigation = await sessionCall(
      lease,
      session,
      `/v1/sessions/${session.session_id}/navigate`,
      {
        method: "POST",
        body: { url: site.url, timeout_ms: TIMEOUT_MS, settle_ms: SETTLE_MS },
      },
    );
    if (navigation.status !== 200) {
      const events = await sessionCall(
        lease,
        session,
        `/v1/sessions/${session.session_id}/events?after=0`,
      );
      const failed = events.json?.events?.find((event) => event.type === "navigation.failed");
      record.error = failed?.detail?.message ?? navigation.json?.error?.message ?? navigation.text;
      record.navigation = navigation.json?.error?.details?.navigation ?? null;
      record.http_status = record.navigation?.http_status ?? null;
      record.screenshot_path = failed?.detail?.screenshotPath ?? null;
    }
    const observed = await sessionCall(
      lease,
      session,
      `/v1/sessions/${session.session_id}/observe?mode=screenshot&max_chars=4000`,
    );
    if (observed.status !== 200) {
      record.error = record.error ?? observed.json?.error?.message ?? observed.text;
    } else {
      const observation = observed.json;
      record.observation = {
        url: observation.url,
        title: observation.title,
        ready_state: observation.ready_state,
        loading: observation.loading,
        viewport: observation.viewport,
        dom: observation.dom,
        body_text_length: observation.body_text?.length ?? 0,
        body_text_head: observation.body_text?.slice(0, 240) ?? "",
      };
      record.final_url = observation.url;
      record.title = observation.title;
      record.navigation = observation.navigation ?? null;
      record.runtime = observation.runtime ?? null;
      record.network = observation.network ?? null;
      record.http_status = observation.navigation?.http_status ?? null;
      const markers = detectMarkers(
        observation.body_text ?? "",
        observation.title ?? "",
        observation.url ?? "",
      );
      record.challenge = markers.challenge;
      record.login = markers.login;
      if (observation.screenshot?.base64) {
        const png = Buffer.from(observation.screenshot.base64, "base64");
        record.screenshot = analyzePng(png);
        record.screenshot_path = path.join(outDir, `${site.name}.png`);
        await writeFile(record.screenshot_path, png);
      }
    }
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (session) {
      await sessionCall(lease, session, `/v1/sessions/${session.session_id}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    record.duration_ms = Date.now() - started;
    record.status = classify(record, record.screenshot);
    report.sites.push(record);
    const bits = [
      String(index + 1).padStart(2, "0"),
      site.name.padEnd(10),
      record.status.padEnd(10),
      `${record.duration_ms}ms`.padStart(8),
      `dom=${record.observation?.dom?.elements ?? "-"}`.padStart(10),
      `text=${record.observation?.body_text_length ?? "-"}`.padStart(10),
      `sd=${record.screenshot?.stddev_luminance ?? "-"}`.padStart(9),
      record.challenge.length ? `challenge=${record.challenge.join("+")}` : "",
      record.error ? `error=${record.error.slice(0, 120)}` : "",
    ];
    console.log(bits.filter(Boolean).join(" "));
    if (index < selected.length - 1) await sleep(INTERVAL_MS);
  }
}

await brokerCall(broker, `/v1/leases/${lease.lease_id}`, { method: "DELETE" }).catch(() => undefined);

report.finished_at = new Date().toISOString();
report.summary = report.sites.reduce((summary, site) => {
  summary[site.status] = (summary[site.status] ?? 0) + 1;
  return summary;
}, {});
const reportPath = path.join(outDir, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`summary ${JSON.stringify(report.summary)}`);
console.log(`report ${reportPath}`);
