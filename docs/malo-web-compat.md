# malo-browser 真实站点兼容性调研

日期：2026-11-03  
范围：无头 session、单页顶层加载、每站一次、不重试、不登录、不处理验证码

## 结论

升级后的 malo-browser 在 12 个代表性站点中，9 个可以正常加载和观察；
1 个是登录墙，1 个是网络层不可达，1 个是站点侧 HTTP 403 + 人机验证。

这不是“所有网站都能过”的结论。更准确的结论是：

- 常见静态页、SPA、搜索、电商、视频、WebGL、地图库页面可以在隐藏 session 中渲染
- 异步页面必须等 DOM/网络稳定，不能只等 `load`
- JS challenge 不一定是拦截，可能只是二次导航；等最终页即可
- 登录墙、滑块/验证码、IP 级反爬必须显式识别，不能伪装成功
- 我们没有做 stealth、UA 伪造、验证码破解或登录态复用

## 方法

用仓库内脚本串行探测：

```bash
python3 -m http.server 4788 --bind 127.0.0.1 --directory out/fixture
npm run daemon

MALO_BROKER_FILE=~/.malo-browser/broker.json \
MALO_PROBE_INTERVAL_MS=8000 \
MALO_PROBE_TIMEOUT_MS=25000 \
node scripts/malo-web-probe.mjs
```

每个站点：

- 新建独立 session
- 只加载顶层页面一次
- 等 `settle_ms`（默认 6000ms）内的 DOM/网络稳定
- 记录 HTTP 状态、最终 URL、标题、DOM/文本、失败请求、控制台错误
- 取一张截图并检查亮度方差、非白像素比例、颜色数
- 关闭 session 后继续下一个站点

没有并发、没有重试、没有登录、没有处理验证码。

## 基线结果

升级前的问题：

| 站点 | 基线现象 | 根因 |
|---|---|---|
| Reddit | DOM 0、标题空、截图却是最终页 | `load` 后发生 JS challenge 二次导航，观察太早 |
| Three.js examples | 只剩侧栏，主列表空 | 列表由异步请求填充，观察太早 |
| OpenStreetMap | 25s 超时、截图全黑 | 本机网络到站点超时 |
| 知乎 | 被当成 captcha | 实际是 `/signin` 登录墙，登录表单里的“验证码登录”不是挑战 |
| NYT | HTTP 403 + 腾讯滑块 | 站点侧人机验证，非渲染失败 |

升级后复测：

| 站点 | 类型 | 结果 |
|---|---|---|
| example.com | 静态基线 | ok |
| developer.mozilla.org | 文档/JS | ok |
| github.com | SPA | ok |
| baidu.com | 搜索 | ok |
| zhihu.com | 问答/登录墙 | login-wall（`/signin`） |
| taobao.com | 电商 | ok |
| bilibili.com | 视频 | ok |
| reddit.com | 社交/JS challenge | ok（等待二次导航后） |
| threejs.org/examples/ | WebGL 列表 | ok（等待异步列表） |
| openstreetmap.org | 地图 | network-error（`ERR_CONNECTION_TIMED_OUT`） |
| gov.cn | 中文静态门户 | ok |
| nytimes.com | 新闻/反爬 | challenge（HTTP 403 + 腾讯滑块） |

## 关键发现

### 1. “加载完成”不等于“页面稳定”

`document.readyState === "complete"` 只说明主文档和同步资源到了，不保证：

- SPA 的异步数据已经渲染
- JS challenge 已经完成二次跳转
- 地图/表格/列表已经填充

malo-browser 现在同时看：

- `Page.lifecycleEvent` 的 `networkAlmostIdle`
- URL、DOM 元素数的稳定采样
- challenge URL 的额外等待
- 最终 `navigation.settle` 诊断

### 2. JS challenge 不是统一按“反爬失败”处理

Reddit 的 URL 带有 `js_challenge=1` / `jsc_token`，但等待后页面正常渲染。
如果只看 URL 或首屏 DOM，会误判为 blocked。

当前策略：

- challenge URL + DOM 仍很小：继续等，最多 `settle_ms`
- challenge URL + DOM 已经丰富：按正常页面返回
- 超时后仍无内容：按 partial/timeout 返回，不伪装成功

### 3. 网络失败和站点反爬要分开

OpenStreetMap 的 `chrome-error://chromewebdata/`、`ERR_CONNECTION_TIMED_OUT (-118)`
是本机网络不可达，不是页面脚本或反爬问题。malo-browser 现在把这类失败放在
`error.details.navigation.net_error`，不会只报一个“页面未加载”。

NYT 的 403 + 滑块是站点侧挑战。两者处理方式不同：

- 网络失败：检查出口、DNS、代理或目标站点可达性
- 站点挑战：停止自动重试，转人工 `watch` / 登录态 session / 白名单站点

### 4. UA 和 webdriver 状态

当前 headless Chromium 暴露：

- `navigator.webdriver === false`
- UA 包含 `MaloBrowser/0.1.0 Chrome/156... Electron/45.1.0`

这组信息已经通过 `observe.runtime` 暴露给 agent。没有做 UA 伪装。
如果某站点只接受标准 Chrome UA，应作为显式兼容选项单独评估，不默认开启。

### 5. 真实页面需要结构化内容，不只是正文

仅返回 `body_text` 不足以让 agent 可靠操作。`snapshot` 现在提供：

- 标题层级、链接、按钮、输入框、下拉框、表单
- 表格、landmark、iframe、dialog、alert/live region
- 可交互元素的 selector、坐标、尺寸
- 截断标记

在 Taobao 实测 snapshot 返回约 28KB，包含 40 个链接、6 个按钮、1 个输入框和 40 个可交互元素。

## 后续建议

1. ~~增加 `watch` 人工接管~~（已实现）：遇到登录、滑块、验证码时让人处理一次，再把同一 session 交回 agent。
2. ~~登录态持久化与显式复用~~（已实现）：用 `profile` 显式开启，同名 profile 跨 session / 跨重启保留 cookies；
   未指定 profile 的 session 仍然关闭即清空，不混用登录态。
3. 增加站点策略层：按域名配置超时、settle、是否允许自动加载、是否需要人工。
4. 为视频/地图/Canvas 增加专门的渲染检查，而不只看 DOM 和截图方差。
5. 继续做真实站点回归，但保持“每站一次、不重试、不并发”的探测纪律。

## 不做

- 不伪造 `navigator.webdriver`
- 不伪造 UA 绕过站点策略
- 不自动破解滑块、验证码或登录
- 不把挑战页、空白页或 403 当成成功
- 不对同一站点高频重试
