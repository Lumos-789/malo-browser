# Phase 1 实施记录（2026-10-28）

目标：把 Phase 0 的单文件 spike 拆成可维护的 MVP 骨架，跑通
「Scene → Runner → Stage → Recorder → Evidence」一条链路，并提供 Director 控制台。

本轮由 5 个子 agent 并行实现四个互不重叠的模块（Scene / Runner / Security / Director），
Capture 由第 5 个 agent 负责；主进程装配、协议、窗口、IPC 与集成验收在主线程完成。

## 模块与接口

| 模块 | 入口 | 说明 |
|---|---|---|
| Scene | `src/main/scenes` | Zod 严格校验、一次收集全部错误、`${var}` / `${env:}` 插值、稳定脚本 hash |
| Runner | `src/main/runner` | 状态机 + 18 个动作，只依赖 `PageDriver` / `OverlayPort`，物理点击与输入 |
| Security | `src/main/security` | 来源白名单、demo 路径穿越与符号链接防护、权限默认拒绝、下载默认取消 |
| Capture | `src/main/capture` | screencast 抓帧、30fps 时间轴补帧、ffmpeg 编码、ffprobe/黑帧校验、evidence |
| Director | `src/renderer/director` | 三栏控制台 + 底栏控制，lucide 图标，MOCK 兜底有明显标记 |
| 装配 | `src/main/app-controller.ts`、`ipc.ts`、`demo-protocol.ts` | 状态快照、命令分发、`demo://` 按 session 注册 |

契约在 `src/shared/{types,errors,scene}.ts` 与 `src/main/core/{page-driver,ports}.ts`，
Runner / Capture 不 import Electron，后续换 CEF 只需替换驱动与窗口壳。

## 验收结果

- `npm test`：4 个测试文件、77 条单测全绿（Scene 17、Runner 16、Security 39、Timeline 5）。
- `npx tsc -p tsconfig.main.json --noEmit`、`npx tsc -p tsconfig.renderer.json`：通过。
- 无头全链路：`--mode=app --autorun=report-review`，7 步全部通过，
  产出 6.967s / 209 帧 / 1920x1080 / 30fps 的 MP4 与 evidence（`status: passed`）。
- 覆盖层验证：聚光、标注、光标都进入成片（抽帧目检）。
- Director 桥接：`--director-check` 返回 `api=object, scenes=1, mockBadge=false`。

## 集成时修掉的问题

1. `protocol.handle` 只作用于默认 session；Stage 使用独立 partition，必须在 Stage 的
   session 上注册 `demo://`，否则 `loadURL` 报 `ERR_FAILED`。
2. `normalize` 前先 `path.resolve(scenesRoot)`；`resolveScenePath` 只接受绝对场景根。
3. debugger 未 attach 前调用 `Runtime.evaluate` 会报 `No target available`；
   `navigate()` 现在只用 `loadURL`，attach 之后才走 CDP。
4. 沙箱 preload 不能 `require` 本地模块；通道常量内联在 `src/preload/index.ts`。
5. 视觉动作的 `seconds` 之前只控制覆盖层动画、不阻塞时间轴，导致 7 步 1.2 秒跑完；
   现在 `seconds` 同时作为 hold，聚光和标注在成片里停留足够时间。
6. evidence 的时长自检改为「视频 vs 步骤耗时」，避免把录制准备时间算进容差。

## 当前边界

- 多场景切换、控制 API、Stage 全屏与多显示器已在 [phase1b.md](phase1b.md) 补齐。
- `.app` 未签名、未公证；打包脚本仍是 dir target。
- 文本输入使用 `insertText` 近似，强依赖 keydown 的编辑器需要补 `typeText`。
- evidence 的 `steps` 现在跨场景累积（见 phase1b.md），未执行的后续场景步骤不会进入证据。
