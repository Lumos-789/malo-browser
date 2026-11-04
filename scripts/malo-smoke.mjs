#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const brokerFile = process.argv[2] ?? `${process.env.HOME}/.malo-browser/broker.json`;
const fixtureBase = process.argv[3] ?? "http://127.0.0.1:4788";

const LOGIN_TEST_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Malo smoke test login</title>
  </head>
  <body>
    <h1>Smoke test login</h1>
    <form id="login">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="username" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" />
      <p id="error" role="alert"></p>
      <button id="submit" type="submit">Sign in</button>
    </form>
    <button id="watch-approve" type="button">Approve</button>
    <script>
      const persist = new URLSearchParams(location.search).get("persist") === "1";
      if (persist && document.cookie.split("; ").includes("smoke_session=1")) {
        location.replace("/signed-in?restored=1");
      }
      document.getElementById("login").addEventListener("submit", (event) => {
        event.preventDefault();
        const ok =
          document.getElementById("username").value === "demo" &&
          document.getElementById("password").value === "secret";
        if (!ok) {
          document.getElementById("error").textContent = "Invalid credentials";
          return;
        }
        if (persist) document.cookie = "smoke_session=1; path=/";
        location.href = "/signed-in";
      });
      document.getElementById("watch-approve").addEventListener("click", () => {
        location.href = "/signed-in";
      });
    </script>
  </body>
</html>`;

const loginServer = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.url?.startsWith("/signed-in") ? "<!doctype html><title>Signed in</title><h1>Signed in</h1>" : LOGIN_TEST_PAGE);
});
await new Promise((resolve) => loginServer.listen(0, "127.0.0.1", resolve));
const loginBase = `http://127.0.0.1:${loginServer.address().port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(base, path, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // callers assert on status and text for non-JSON failures
  }
  return { status: response.status, json, text };
}

function brokerCall(broker, path, options = {}) {
  return requestJson(broker.endpoint, path, {
    ...options,
    headers: { "x-malo-broker-token": broker.token, ...options.headers },
  });
}

function leaseCall(lease, path, options = {}) {
  return requestJson(lease.endpoint, path, {
    ...options,
    headers: { "x-malo-lease-token": lease.token, ...options.headers },
  });
}

function sessionCall(lease, session, path, options = {}) {
  return leaseCall(lease, path, {
    ...options,
    headers: { "x-malo-session-token": session.session_token, ...options.headers },
  });
}

const broker = JSON.parse(await readFile(brokerFile, "utf8"));
const health = await requestJson(broker.endpoint, "/health");
assert(health.status === 200 && health.json?.service === "malo-broker", "broker health 失败");

const leaseA = (await brokerCall(broker, "/v1/leases", {
  method: "POST",
  body: { agent_id: "smoke-agent-a" },
})).json;
const leaseB = (await brokerCall(broker, "/v1/leases", {
  method: "POST",
  body: { agent_id: "smoke-agent-b" },
})).json;
assert(leaseA && leaseB, "lease 创建失败");
assert(leaseA.endpoint !== leaseB.endpoint, "两个 agent 拿到了同一个端口");
assert(leaseA.token !== leaseB.token, "两个 agent 拿到了同一个 token");

const a1 = (await leaseCall(leaseA, "/v1/sessions", {
  method: "POST",
  body: { name: "alpha", width: 1280, height: 800 },
})).json;
const a2 = (await leaseCall(leaseA, "/v1/sessions", {
  method: "POST",
  body: { name: "beta", width: 1280, height: 800 },
})).json;
const b1 = (await leaseCall(leaseB, "/v1/sessions", {
  method: "POST",
  body: { name: "gamma", width: 1280, height: 800 },
})).json;
assert(a1 && a2 && b1, "session 创建失败");
assert(a1.session_token !== a2.session_token, "同一 lease 下的 session token 重复");
assert(a1.downloads_dir !== a2.downloads_dir, "session 下载目录串用");
assert(a1.artifacts_dir !== a2.artifacts_dir, "session 产物目录串用");
assert(a1.downloads_dir.includes(a1.session_id), "下载目录没有绑定 session id");

for (const [lease, session, who] of [
  [leaseA, a1, "a1"],
  [leaseA, a2, "a2"],
  [leaseB, b1, "b1"],
]) {
  const response = await sessionCall(
    lease,
    session,
    "/v1/sessions/" + session.session_id + "/navigate",
    { method: "POST", body: { url: `${fixtureBase}/index.html?compare=1&who=${who}` } },
  );
  assert(response.status === 200, `session ${who} 导航失败：${response.status} ${response.text}`);
  assert(response.json.url.includes(`who=${who}`), `session ${who} URL 串用`);
}

const lightA1 = (await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/observe?mode=light`)).json;
const lightA2 = (await sessionCall(leaseA, a2, `/v1/sessions/${a2.session_id}/observe?mode=light`)).json;
assert(lightA1.url.includes("who=a1") && lightA2.url.includes("who=a2"), "light observation URL 串用");
assert(lightA1.dom.interactive > 0, "light observation 缺少可交互元素统计");

const tools = (await leaseCall(leaseA, "/v1/tools")).json;
assert(
  tools?.tools?.some((tool) => tool.name === "snapshot") &&
    tools?.tools?.some((tool) => tool.name === "extract"),
  "工具清单缺少 snapshot / extract",
);

const snapshot = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/snapshot`, {
  method: "POST",
  body: { max_chars: 4000, max_items: 80 },
});
assert(snapshot.status === 200, `snapshot 失败：${snapshot.status} ${snapshot.text}`);
assert(snapshot.json.result.headings.length > 0, "snapshot 没有 headings");
assert(snapshot.json.result.buttons.length > 0, "snapshot 没有 buttons");
assert(snapshot.json.result.inputs.length > 0, "snapshot 没有 inputs");
assert(snapshot.json.result.text.length > 100, "snapshot 文本过短");

const extracted = await sessionCall(
  leaseA,
  a1,
  `/v1/sessions/${a1.session_id}/tools/extract`,
  {
    method: "POST",
    body: { selector: '[data-demo-id="review-count"]', mode: "text" },
  },
);
assert(extracted.status === 200, `extract 失败：${extracted.status} ${extracted.text}`);
assert(extracted.json.result.matches[0]?.text === "0", "extract 没有读到计数值");

const crossToken = await requestJson(leaseA.endpoint, `/v1/sessions/${a2.session_id}`, {
  headers: {
    "x-malo-lease-token": leaseA.token,
    "x-malo-session-token": a1.session_token,
  },
});
assert(crossToken.status === 401, `session token 越权访问未被拒绝：${crossToken.status}`);

const fill = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/fill`, {
  method: "POST",
  body: { selector: '[data-demo-id="search"]', text: "风险" },
});
assert(fill.status === 200, `fill 失败：${fill.status} ${fill.text}`);
assert(fill.json.result.observation.body_text.includes("风险订单"), "fill 后没有过滤出风险订单");

const untouchedA2 = (await sessionCall(leaseA, a2, `/v1/sessions/${a2.session_id}/observe?mode=light`)).json;
assert(untouchedA2.body_text.includes("华东渠道首批铺货"), "session a1 的输入污染了 session a2");

const focus = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/focus`, {
  method: "POST",
  body: { selector: '[data-demo-id="search"]' },
});
assert(focus.status === 200, `focus 失败：${focus.status} ${focus.text}`);

const hover = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/hover`, {
  method: "POST",
  body: { selector: '[data-demo-id="increment"]' },
});
assert(hover.status === 200, `hover 失败：${hover.status} ${hover.text}`);

const scrollIntoView = await sessionCall(
  leaseA,
  a1,
  `/v1/sessions/${a1.session_id}/tools/scroll_into_view`,
  { method: "POST", body: { selector: '[data-demo-id="increment"]' } },
);
assert(scrollIntoView.status === 200, `scroll_into_view 失败：${scrollIntoView.status} ${scrollIntoView.text}`);

const click = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/click`, {
  method: "POST",
  body: { selector: '[data-demo-id="increment"]' },
});
assert(click.status === 200, `click 失败：${click.status} ${click.text}`);
assert(click.json.result.action === "click", "click 工具没有返回动作结果");

await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/navigate`, {
  method: "POST",
  body: { url: `${fixtureBase}/index.html?compare=1&who=a1-second` },
});
const history = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/history`, {
  method: "POST",
  body: { action: "back" },
});
assert(history.status === 200, `history 失败：${history.status} ${history.text}`);
await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/sleep`, {
  method: "POST",
  body: { ms: 500 },
});
const afterHistory = (await sessionCall(
  leaseA,
  a1,
  `/v1/sessions/${a1.session_id}/observe?mode=light`,
)).json;
assert(afterHistory.url.includes("who=a1"), `history back 后 URL 不对：${afterHistory.url}`);

const events = (await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/events?after=0`)).json;
assert(
  events.events.some((event) => event.type === "action.completed"),
  "session 事件流没有记录动作完成",
);
const toolEvents = await sessionCall(leaseA, a1, `/v1/sessions/${a1.session_id}/tools/events`, {
  method: "POST",
  body: { after: 0, limit: 20 },
});
assert(toolEvents.status === 200, `tools/events 失败：${toolEvents.status} ${toolEvents.text}`);
assert(toolEvents.json.result.events.length > 0, "tools/events 没有返回事件");

const screenshot = await sessionCall(
  leaseA,
  a1,
  `/v1/sessions/${a1.session_id}/observe?mode=screenshot&max_chars=200`,
);
assert(screenshot.status === 200, `截图失败：${screenshot.status}`);
const png = Buffer.from(screenshot.json.screenshot.base64, "base64");
assert(png.length > 5_000, `截图过小：${png.length} bytes`);
assert(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "截图不是 PNG");

const loginUrl = `${loginBase}/login`;
const b1Path = (path) => `/v1/sessions/${b1.session_id}${path}`;

await sessionCall(leaseB, b1, b1Path("/navigate"), { method: "POST", body: { url: loginUrl } });
const goodLogin = await sessionCall(leaseB, b1, b1Path("/tools/login"), {
  method: "POST",
  body: { mode: "password", username: "demo", password: "secret" },
});
assert(goodLogin.status === 200, `账号密码登录失败：${goodLogin.status} ${goodLogin.text}`);
assert(goodLogin.json.result.ok === true, `账号密码登录未通过：${goodLogin.json.result.reason}`);
assert(goodLogin.json.result.final_url.includes("/signed-in"), "账号密码登录后没有进入成功页");
assert(!goodLogin.text.includes("secret"), "login 响应回显了密码");

await sessionCall(leaseB, b1, b1Path("/navigate"), { method: "POST", body: { url: loginUrl } });
const badLogin = await sessionCall(leaseB, b1, b1Path("/tools/login"), {
  method: "POST",
  body: { mode: "password", username: "demo", password: "wrong-secret" },
});
assert(badLogin.status === 200, `错误凭据登录请求失败：${badLogin.status} ${badLogin.text}`);
assert(badLogin.json.result.ok === false, "错误凭据被判成登录成功");
assert(badLogin.json.result.reason === "login_error", `错误凭据原因不对：${badLogin.json.result.reason}`);
assert(!badLogin.text.includes("wrong-secret"), "错误凭据响应回显了密码");

await sessionCall(leaseB, b1, b1Path("/navigate"), { method: "POST", body: { url: loginUrl } });
const typedSecret = "hunter2-smoke-secret";
await sessionCall(leaseB, b1, b1Path("/tools/fill"), {
  method: "POST",
  body: { selector: "#password", text: typedSecret },
});
const loginSnapshot = await sessionCall(leaseB, b1, b1Path("/tools/snapshot"), {
  method: "POST",
  body: { max_chars: 4000, max_items: 80 },
});
assert(loginSnapshot.status === 200, `登录页 snapshot 失败：${loginSnapshot.status} ${loginSnapshot.text}`);
assert(
  loginSnapshot.json.result.inputs.some((input) => input.sensitive === true),
  "snapshot 没有标记密码输入框",
);
assert(!loginSnapshot.text.includes(typedSecret), "snapshot 泄露了密码框内容");

const watched = await sessionCall(leaseB, b1, b1Path("/tools/watch"), {
  method: "POST",
  body: { show: true, focus: false },
});
assert(watched.status === 200, `watch 失败：${watched.status} ${watched.text}`);
assert(watched.json.result.visible === true, "watch 没有把窗口显示出来");

const watchLoginPromise = sessionCall(leaseB, b1, b1Path("/tools/login"), {
  method: "POST",
  body: { mode: "watch", timeout_ms: 30_000, focus: false },
});
await new Promise((resolve) => setTimeout(resolve, 800));
const approve = await sessionCall(leaseB, b1, b1Path("/tools/click"), {
  method: "POST",
  body: { selector: "#watch-approve" },
});
assert(approve.status === 200, `人工接管点击失败：${approve.status} ${approve.text}`);
const watchLogin = await watchLoginPromise;
assert(watchLogin.status === 200, `人工接管登录失败：${watchLogin.status} ${watchLogin.text}`);
assert(watchLogin.json.result.ok === true, `人工接管登录未通过：${watchLogin.json.result.reason}`);
assert(watchLogin.json.result.watch?.window === "hidden", "人工接管成功后窗口没有收起");

const loginEvents = (await sessionCall(leaseB, b1, `/v1/sessions/${b1.session_id}/events?after=0`))
  .json;
assert(
  !JSON.stringify(loginEvents).includes(typedSecret) && !JSON.stringify(loginEvents).includes("wrong-secret"),
  "事件流泄露了凭据",
);

const profileName = "smoke-work";
const createProfiledSession = async (name) =>
  (
    await leaseCall(leaseB, "/v1/sessions", {
      method: "POST",
      body: { name, width: 1280, height: 800, profile: profileName },
    })
  ).json;

const profiled = await createProfiledSession("profile-login");
assert(profiled?.profile === profileName, "profile session 没有绑定 profile");
await sessionCall(leaseB, profiled, `/v1/sessions/${profiled.session_id}/navigate`, {
  method: "POST",
  body: { url: `${loginBase}/login?persist=1` },
});
const profiledLogin = await sessionCall(
  leaseB,
  profiled,
  `/v1/sessions/${profiled.session_id}/tools/login`,
  { method: "POST", body: { mode: "password", username: "demo", password: "secret" } },
);
assert(profiledLogin.json.result.ok === true, `profile 登录失败：${profiledLogin.json.result.reason}`);
assert(profiledLogin.json.result.profile === profileName, "login 结果没有回传 profile");

const lockedProfile = await leaseCall(leaseB, `/v1/profiles/${profileName}`, { method: "DELETE" });
assert(lockedProfile.status === 409, `占用中的 profile 未被拒绝：${lockedProfile.status}`);

await sessionCall(leaseB, profiled, `/v1/sessions/${profiled.session_id}/tools/close`, {
  method: "POST",
  body: {},
});

const profiledAgain = await createProfiledSession("profile-login-2");
await sessionCall(leaseB, profiledAgain, `/v1/sessions/${profiledAgain.session_id}/navigate`, {
  method: "POST",
  body: { url: `${loginBase}/login?persist=1` },
});
const restored = (
  await sessionCall(leaseB, profiledAgain, `/v1/sessions/${profiledAgain.session_id}/observe?mode=light`)
).json;
assert(restored.url.includes("restored=1"), `profile 没有恢复登录态：${restored.url}`);

const anonymous = (
  await leaseCall(leaseB, "/v1/sessions", { method: "POST", body: { name: "anonymous" } })
).json;
await sessionCall(leaseB, anonymous, `/v1/sessions/${anonymous.session_id}/navigate`, {
  method: "POST",
  body: { url: `${loginBase}/login?persist=1` },
});
const anonymousState = (
  await sessionCall(leaseB, anonymous, `/v1/sessions/${anonymous.session_id}/observe?mode=light`)
).json;
assert(!anonymousState.url.includes("restored=1"), "匿名 session 复用了 profile 的登录态");

const profiles = (await leaseCall(leaseB, "/v1/profiles")).json;
assert(
  profiles.profiles.some((item) => item.name === profileName && item.active_sessions >= 1),
  "profile 列表缺少活动会话",
);

await sessionCall(leaseB, profiledAgain, `/v1/sessions/${profiledAgain.session_id}/tools/close`, {
  method: "POST",
  body: {},
});
const clearedProfile = await leaseCall(leaseB, `/v1/profiles/${profileName}`, { method: "DELETE" });
assert(clearedProfile.status === 200, `清理 profile 失败：${clearedProfile.status} ${clearedProfile.text}`);
assert(clearedProfile.json.profile === profileName, "清理 profile 没有回传名称");

const leaseState = (await leaseCall(leaseA, "/v1/state")).json;
assert(leaseState.sessions.length === 2, "lease A 的 session 列表不完整");

const closed = await sessionCall(leaseA, a2, `/v1/sessions/${a2.session_id}/tools/close`, {
  method: "POST",
  body: {},
});
assert(closed.status === 200, "关闭 session 失败");
const gone = await sessionCall(leaseA, a2, `/v1/sessions/${a2.session_id}`);
assert(gone.status === 404, `已关闭 session 仍可访问：${gone.status}`);

const portB = Number(new URL(leaseB.endpoint).port);
const releasedB = await brokerCall(broker, `/v1/leases/${leaseB.lease_id}`, { method: "DELETE" });
assert(releasedB.status === 200, "释放 lease B 失败");
let bAlive = true;
try {
  await fetch(`${leaseB.endpoint}/health`, { signal: AbortSignal.timeout(800) });
} catch {
  bAlive = false;
}
assert(!bAlive, "释放 lease 后端口仍在应答");

const portA = Number(new URL(leaseA.endpoint).port);
const releasedA = await brokerCall(broker, `/v1/leases/${leaseA.lease_id}`, { method: "DELETE" });
assert(releasedA.status === 200, "释放 lease A 失败");
const finalState = (await brokerCall(broker, "/v1/state")).json;
assert(finalState.leases.length === 0, "释放后仍有 lease 残留");
assert(!finalState.ports.used.includes(portA), "lease A 端口未归还端口池");
assert(!finalState.ports.used.includes(portB), "lease B 端口未归还端口池");

await new Promise((resolve) => loginServer.close(resolve));

console.log(
  JSON.stringify(
    {
      status: "passed",
      broker: broker.endpoint,
      leases: [leaseA.lease_id, leaseB.lease_id],
      sessions: [a1.session_id, a2.session_id, b1.session_id],
      tools: tools.tools.map((tool) => tool.name),
      snapshot: {
        headings: snapshot.json.result.headings.length,
        buttons: snapshot.json.result.buttons.length,
        inputs: snapshot.json.result.inputs.length,
      },
      screenshot_bytes: png.length,
      login: {
        password_ok: goodLogin.json.result.ok,
        wrong_password_reason: badLogin.json.result.reason,
        watch_ok: watchLogin.json.result.ok,
      },
      profile: {
        name: profileName,
        restored: restored.url.includes("restored=1"),
        anonymous_isolated: !anonymousState.url.includes("restored=1"),
      },
      ports: { a: portA, b: portB },
      final_ports: finalState.ports,
    },
    null,
    2,
  ),
);
