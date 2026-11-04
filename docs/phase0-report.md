# Malo Browser Phase 0 技术验证报告

日期：2026-10-28

结论：**GO**。Electron 45.1.0 + Chromium 156 可以承担 Stage + CDP 录制，
无头后台录制稳定可用，出片规格与现有 recorder-pipe 链路一致。

## 1. 环境

| 项 | 值 |
|---|---|
| 机器 | macOS 27.0.1 (26A434)，arm64 |
| Electron | 45.1.0 |
| Chromium | 156.0.8078.49 |
| Node | 24.22.1（Electron 内置）/ 24.15.0（本机构建） |
| ffmpeg | `/opt/homebrew/bin/ffmpeg` |
| 视口 | 1440x900，DPR 2（对照录制 1440x810） |

## 2. 任务对照

| ID | 任务 | 结果 |
|---|---|---|
| P0-01 | 最小应用 | 完成，`npm run build` + `electron .` |
| P0-02 | `BaseWindow` + `WebContentsView` 固定视口 | 完成，1440x900 无边框 Stage |
| P0-03 | `webContents.debugger` 接 CDP | 完成，物理点击/输入/断言通过 |
| P0-04 | 光标、波纹、高亮覆盖层 | 完成，覆盖层进入成片（蓝像素差分 7080→21275） |
| P0-05 | `Page.startScreencast` 录 10 秒 | 完成，926 张原始帧 |
| P0-06 | ffmpeg 合成 1920x1080/30fps | 完成，300 帧 / 10.000s |
| P0-07 | evidence 与 recorder-pipe 对比 | 完成，SSIM 0.9857 |
| P0-08 | 隐藏窗口/headless | 完成，默认无头模式可用 |
| P0-09 | 最小 `.app` | 完成，打包后 3 秒录制通过 |

## 3. 主证据

`evidence/hidden.mp4`（默认参数，无头）

| 指标 | 值 |
|---|---|
| 时长 | 10.000s（目标 10s） |
| 帧数 / 帧率 | 300 / 30.00 |
| 分辨率 | 1920x1080 |
| 原始 screencast 帧 | 926（约 92.6 fps 到达，按变化触发） |
| 黑帧 | 0.00s（0%） |
| 应用 CPU | 平均 5.29%，峰值 6.04% |
| 窗口可见 | false |
| SHA256 | `d33d24f1064655c43e9320c0418d9f0f2adb78e2a9c7b66e6697efa0ae341037` |

步骤全部通过：`wait_for` → `move` → 物理 `click`（React 计数 0→1）→ `fill`
（搜索框输入「风险」）→ `assert`（只剩风险行）→ `highlight`。

## 4. 窗口模式矩阵

| 窗口模式 | 录制 | 物理交互 | 说明 |
|---|---|---|---|
| `hidden`（默认 + focus emulation） | 通过（274 帧/3s） | 通过 | 真无头，推荐 |
| `hidden`（无 focus emulation） | 有帧 | **失败** | 点击被丢弃，计数停在 0 |
| `inactive` | 通过（221 帧/3s） | 通过 | 窗口可见，不抢焦点 |
| `offscreen` | 通过（279 帧/3s） | 通过 | 窗口移到屏幕外 |
| `ghost` | 通过（279 帧/3s） | 通过 | 透明度 0 |

结论：headless 依赖 `Emulation.setFocusEmulationEnabled(true)`，不是单纯把窗口藏起来。

## 5. 与现有链路对比

对照方式：同一 fixture（冻结动画，`?compare=1`），
Electron 无头录 10s vs 无头 Chrome 156 用 `pipe.browser_capture.Recorder` 录 10s，
两边都是 1440 宽 16:9 视口。

| 项 | Electron | Chrome + recorder-pipe |
|---|---|---|
| 分辨率 | 1920x1080 | 1920x1080 |
| 帧率 | 30.00 | 30.00 |
| 帧数 | 300 | 300 |
| 时长 | 10.000s | 10.000s |
| 原始帧（静态页） | 1 | 1 |
| SHA256 | `b5bfc802…22ff45` | `f3c03c3e…a2b9e4` |

画面 SSIM：**0.9857**（差异主要是字体抗锯齿与 Retina 缩放，布局一致）。

静态页只来 1 帧是两边共同行为，时间轴按 30fps 补帧后才得到 300 帧，
说明「帧到达稀疏 ≠ 录制失败」的判断是对的。

## 6. 打包验证

`npm run package` 产出 `dist/mac-arm64/Malo Browser.app`（未签名、未公证）。

打包版 3 秒冒烟：通过，90 帧 / 1920x1080 / 30fps / 无黑帧，
SHA256 `80614e2f…3c55740e`。

打包时踩到两个真实问题，已修：

1. `pngjs` 放在 devDependencies，打包后被裁掉，主进程 require 失败。已移到 dependencies。
2. 主进程未捕获异常会弹系统 NSAlert，LSUIElement 下不可见但阻塞进程。
   已加 `uncaughtException` / `unhandledRejection` 兜底：打印后非零退出。

## 7. 当前边界

- 只验证了 fixture，没有真实内网站点（白名单、登录态、权限都在 Phase 1）。
- 本地页面仍走 `http://127.0.0.1`，`demo://` 协议未实现。
- `.app` 未签名、未公证，跨机器分发前要补。
- Director 界面、Scene YAML、Runner 状态机尚未实现。
- 与 recorder-pipe 的对照用的是独立无头 Chrome，不是常驻的接管浏览器，避免改动用户正在用的窗口；
  链路参数（max 1920x1080、jpeg 90、30fps、硬链接铺帧、crf 18）一致。

## 8. 复现

```bash
npm run build
python3 -m http.server 4788 --bind 127.0.0.1 --directory out/fixture &
npx electron . --mode=record --seconds=10 --out=evidence --label=hidden

# 对照（可选）
npx electron . --mode=record --plain --seconds=10 --width=1440 --height=810 \
  --url="http://127.0.0.1:4788/index.html?compare=1" --out=evidence --label=compare-electron
"Google Chrome" --headless=new --remote-debugging-port=9339 --window-size=1440,810 &
~/recorder-pipe/.venv/bin/python scripts/baseline_chrome.py \
  "http://127.0.0.1:4788/index.html?compare=1" evidence/compare-chrome.mp4 10
node scripts/compare.cjs evidence/compare-electron.mp4 evidence/compare-chrome.mp4 8
```

## 9. 下一步（Phase 1）

1. 拆正式模块：AppController、SceneStore（Zod 校验）、Runner 状态机、SceneManager。
2. Director 窗口与 IPC，Stage 全屏与多显示器。
3. `demo://` 协议、导航白名单、权限默认拒绝、下载拦截。
4. 9 个基础动作 + assert + 失败截图，覆盖 Layer 1 fixture 用例。
5. recorder-pipe 增加 `source: demo-stage` 预检。
6. .app 签名与公证。
