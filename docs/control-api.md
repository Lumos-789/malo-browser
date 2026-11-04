# 控制 API

本地脚本通过 `127.0.0.1` 上的 HTTP 接口驱动 Malo Browser，命令走与 Director 相同的 `dispatchCommand` 通道。

## 启动

```ts
const server = await startControlServer({
  send: (command) => dispatchCommand(controller, command),
  getSnapshot: () => controller.snapshot(),
  onEvent: (listener) => controller.onEvent(listener),
  recordFile: "/tmp/malo-browser-control.json",
});
```

`port` 默认 `0`（系统分配），`token` 默认 32 字节随机 hex。`recordFile` 写入 `{url, token, pid}`，权限 `0600`。

## 鉴权

除 `/health` 外都必须带 token，两种写法等价：

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/state
curl -H "x-demo-token: $TOKEN" http://127.0.0.1:$PORT/scenes
```

## 路由

```bash
curl http://127.0.0.1:$PORT/health
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/state
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/scenes
curl -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"cmd":"run.start","args":{"mode":"record"}}' http://127.0.0.1:$PORT/command
curl -N -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$PORT/events
```

`POST /command` 成功返回 `{"ok":true,"result":...}`；失败返回非 2xx 与 `{"ok":false,"error":{"code","message"}}`。`DemoError` 映射为 400，`E_PROFILE_LOCKED` / `E_STEP_TIMEOUT` / `E_RECORDER_NO_FRAMES` 为 409，其余异常为 500。`/events` 是 SSE，`data:` 行里是 `AppEvent` JSON。连接建立即回一行 `: connected` 注释行，此后每 15 秒发一行 `: ping` 心跳注释行；注释行不产生事件，订阅方可据此区分「暂无事件」与「连接已死」。

## 冒烟脚本

`scripts/control-smoke.mjs` 跑一遍 `scene.load` → `recorder.start` → `run.start` →
`recorder.stop`，并校验产物 evidence 是 `passed`。它连的是已经在跑的实例（无头启动即可，
不抢焦点），token 从 `<out>/control.json` 读：

```bash
npx electron . --mode=app --headless=true --control-api=true --out=out
DEMO_CONTROL_URL=http://127.0.0.1:7317 \
DEMO_CONTROL_TOKEN="$(python3 -c 'import json;print(json.load(open("out/control.json"))["token"])')" \
  npm run smoke:control -- report-review
```

## 安全边界

- 只绑 `127.0.0.1`，不监听 `0.0.0.0`。
- `Host` 只接受 `127.0.0.1:<port>` 与 `localhost:<port>`，防 DNS rebinding。
- token 用 `crypto.timingSafeEqual` 比较。
- 请求体上限 1MB，只接受 `application/json`，非法 JSON 返回 400。
- 不返回 CORS 头，浏览器跨源脚本无法直接调用；本接口面向本机脚本。
