# Phase 1b 实施记录（2026-10-28）

本轮补齐 Phase 1 的四个缺口：本地控制 API、多场景切换、Stage 全屏与多显示器、
后台无窗口模式。三块由三个子 agent 并行实现，主线程负责共享契约、接线、审计与端到端验收。

## 控制 API

- 入口：`src/main/control/server.ts`，随 `--control-api=true` 启动，默认端口 7317，只绑 `127.0.0.1`。
- 命令统一走 `src/main/control-dispatch.ts`，与 Director 的 IPC 共用同一条 `AppController` 通道，没有第二套状态机。
- 路由：`GET /health`、`GET /state`、`GET /scenes`、`POST /command`、`GET /events`（SSE）。
- 安全：随机 32 字节 token（`Authorization: Bearer` 或 `x-demo-token`）、常量时间比较、Host 头只认回环地址、
  1MB 请求体上限、无 CORS 通配、token 落盘 `<out>/control.json` 且强制 0600。
- 使用说明：`docs/control-api.md`。

## 多场景切换

- 关键约束是录制连续性：`scene` 动作切场景时**不重建** `StageWindow` / `WebContentsView`，screencast 不断流。
- `src/main/stage-layout.ts` 提供纯计算（尺寸、安全策略、URL、场景访问去重），可脱离 Electron 单测。
- `AppController` 持有可变的 `currentPolicy`，session 级权限/下载/navigate handler 每次调用读当前策略；
  `scene.ready` 触发 `applySceneSwitch`，调整窗口尺寸、换策略、重注入 overlay、回读真实视口。
- 录制的 evidence 增加 `run.scene_ids`，按首次访问顺序记录；`scene` 仍是入口场景。
- `steps` 跨场景累积：切换前已执行的步骤不会因为场景替换而丢失，`index` 在整段 take 内连续。
- 切场景后留 400ms 落画稳定期，避免新页面还没画出来就交还控制权。
- 回归资产：`fixtures/scenes/multi-a`（1280×720）切到 `multi-b`（1600×900），一条命令可复现。

## 全屏与多显示器

- `stage.fullscreen` / `stage.display` 两条命令；Director 底栏用图标按钮和显示器菜单暴露，快捷键 `⌘⌥F`。
- 隐藏/离屏窗口没有全屏语义，命令直接报 `E_STAGE_LAYOUT`，不做静默降级。

## 无窗口语义

- `--headless=true` 关掉 Director 和 Stage 两处窗口、隐藏 Dock 图标，只留控制 API 与录制链路。
- 交互式 `--mode=app`（`npm start`）默认以 `inactive` 显示 Stage，不抢焦点；`--autorun` / `--director-check` 仍默认 `hidden`。

## 验收

| 项 | 结果 |
|---|---|
| `npm test` | 7 个文件 105 条通过（新增 control-api 11、stage-layout 10、cli 7） |
| `tsc` main / renderer | 通过 |
| `--director-check` | `api=object, scenes=1, mockBadge=false` |
| `--autorun=report-review` | 209 帧 / 6.967s / 1920x1080 / 30fps，evidence `passed` |
| 控制 API 真跑 | 无窗口实例上 `scene.load → recorder.start → run.start → recorder.stop`，210 帧 / 7.00s，evidence `passed`，`capture.headless=true`、`window_visible=false` |
| 多场景真跑 | `--autorun=multi-a`：3.13s / 94 帧，1280x720 → 1600x900，同一路 screencast 未断流，末帧确认为第二幕，`scene_ids` 两项 |
| 打包冒烟 | `npm run package` 后 `Malo Browser.app` 跑 `--autorun=report-review`，213 帧 / 7.10s，evidence `passed`（未签名） |
| delivery-video 预检 | `source: demo-stage` 通过真实证据；把 evidence 改成非无头后预检 FAIL |

## 时长自检口径

`steps_within_take` 从「视频时长 ≈ 步骤耗时」改为区间判断：视频必须覆盖已执行步骤（允许 0.5s 误差），
且不能比步骤耗时多出 `max(5s, 50%)` 的空转。另有 `steps_completed` 保证至少执行过一个步骤，
避免「场景切换后步骤被清空、空壳录制也判过」的假通过。

## 已知边界

- `scene` 动作切完场景后 Runner 仍会暂停，要一镜到底需在 Director 里 resume；autorun 会在切换点停下。
- 未执行的后续场景步骤不会进入 evidence（它们确实没跑过）。
- `.app` 仍未签名/公证；真实业务站点排练需要具体站点与测试账号。
