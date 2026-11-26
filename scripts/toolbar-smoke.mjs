import http from "node:http";
import { createRequire } from "node:module";
import { app } from "electron";

const require = createRequire(import.meta.url);
const { StageWindow } = require("../out/main/windows/stage-window.js");

function log(line) {
  process.stdout.write(`${line}\n`);
}

async function startServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>two</title><h1>two</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function waitFor(check, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

app.whenReady().then(async () => {
  const { server, url } = await startServer();
  const stage = new StageWindow({ width: 900, height: 640, showMode: "hidden", toolbar: true });
  const page = stage.view.webContents;
  const failures = [];

  try {
    // 隐藏窗口不带工具条：到第一次给人看时才建，agent 驱动的会话不为它多养一个渲染进程
    if (stage.toolbar !== null) failures.push("hidden stage created its toolbar eagerly");
    await page.loadURL("data:text/html,<title>one</title><h1>one</h1>");
    if (stage.view.getBounds().height !== 640) {
      failures.push(`page viewport height ${stage.view.getBounds().height} != 640 before the toolbar exists`);
    }
    const bar = stage.ensureToolbar().view.webContents;
    const pageBounds = stage.view.getBounds();
    if (pageBounds.width !== 900 || pageBounds.height !== 640) {
      failures.push(
        `page viewport ${pageBounds.width}x${pageBounds.height} != requested 900x640 (toolbar must not shrink the page)`,
      );
    }
    if (stage.toolbar.view.getBounds().height !== 44) {
      failures.push(`toolbar height ${stage.toolbar.view.getBounds().height} != 44`);
    }
    const wired = await waitFor(async () => {
      try {
        return await bar.executeJavaScript("typeof window.maloToolbar === 'object'");
      } catch {
        return false;
      }
    });
    if (!wired) failures.push("preload bridge not exposed in toolbar");

    await bar.executeJavaScript(`(() => {
      const input = document.getElementById("address");
      input.focus();
      input.value = ${JSON.stringify(url)};
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return true;
    })()`);
    const navigated = await waitFor(() => page.getURL() === url);
    if (!navigated) failures.push(`address enter did not navigate, url=${page.getURL()}`);

    const synced = await waitFor(
      async () => (await bar.executeJavaScript("document.getElementById('address').value")) === url,
    );
    if (!synced) failures.push("address bar did not sync to navigated url");

    await bar.executeJavaScript("window.maloToolbar.back()");
    const wentBack = await waitFor(() => page.getURL().startsWith("data:text/html"));
    if (!wentBack) failures.push(`back did not return to previous page, url=${page.getURL()}`);

    // 人关掉窗口不等于结束会话：同一个页面视图换一个隐藏窗口接着托管
    let humanClosed = 0;
    const kept = new StageWindow({
      width: 640,
      height: 480,
      showMode: "hidden",
      toolbar: true,
      partition: "toolbar-smoke-rehost",
      onWindowClosed: () => {
        humanClosed += 1;
      },
    });
    await kept.view.webContents.loadURL("data:text/html,<title>kept</title><h1>kept</h1>");
    const firstWindow = kept.window;
    const keptView = kept.view;
    firstWindow.close();
    if (humanClosed !== 1) failures.push(`onWindowClosed called ${humanClosed} times, expected 1`);
    if (kept.window === firstWindow || kept.window.isDestroyed()) {
      failures.push("closing the window did not re-host the page view in a fresh window");
    }
    if (kept.view !== keptView) failures.push("page view was replaced when the window was re-created");
    if (kept.isVisible()) failures.push("re-hosted window should stay hidden");
    if (kept.view.getBounds().height !== 480) {
      failures.push(`page viewport changed across re-host: ${JSON.stringify(kept.view.getBounds())}`);
    }
    const keptTitle = await kept.view.webContents.executeJavaScript("document.title");
    if (keptTitle !== "kept") failures.push(`page state lost across re-host: title=${keptTitle}`);
    kept.close();

    // 人给 agent 发信号：工具条上的 完成 / 暂停 / 继续 / 停止
    const signals = [];
    const humanStage = new StageWindow({
      width: 640,
      height: 480,
      showMode: "hidden",
      toolbar: true,
      partition: "toolbar-smoke-human",
      onHumanSignal: (signal) => signals.push(signal),
    });
    const humanBar = humanStage.ensureToolbar().view.webContents;
    const bridged = await waitFor(async () =>
      humanBar.executeJavaScript(
        "typeof window.maloToolbar.done === 'function' && typeof window.maloToolbar.onHuman === 'function'",
      ),
    );
    if (!bridged) failures.push("human signal bridge not exposed in toolbar");
    const panel = (script) => humanBar.executeJavaScript(script);
    await waitFor(() => panel("document.readyState === 'complete'"));
    if ((await panel("document.getElementById('human-pause').textContent")) !== "暂停") {
      failures.push("pause button is not labelled before any signal");
    }
    await panel(`(() => { for (const id of ["human-done", "human-pause", "human-stop"]) document.getElementById(id).click(); return true; })()`);
    const signalled = await waitFor(() => signals.length >= 3);
    if (!signalled || signals.slice(0, 3).join(",") !== "done,pause,stop") {
      failures.push(`toolbar buttons sent ${JSON.stringify(signals)} instead of done,pause,stop`);
    }
    humanStage.setHumanState({ done: false, paused: true, stopped: false });
    const pauseTurnedResume = await waitFor(async () => (await panel("document.getElementById('human-pause').textContent")) === "继续");
    if (!pauseTurnedResume) failures.push("pause button did not turn into 继续 after the session reported paused");
    if ((await panel("document.getElementById('human-state').textContent")) !== "已暂停") {
      failures.push("toolbar does not show the paused state");
    }
    await panel(`document.getElementById("human-pause").click()`);
    if (!(await waitFor(() => signals.includes("resume")))) failures.push("resume was not sent from the toolbar");
    humanStage.setHumanState({ done: false, paused: false, stopped: true });
    const locked = await waitFor(async () =>
      (await panel("Array.from(document.querySelectorAll('button.signal')).map((b) => b.disabled).join()")) === "true,true,true",
    );
    if (!locked) failures.push("signal buttons stay clickable after the human stopped the session");
    humanStage.close();
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    stage.close();
    server.close();
  }

  if (failures.length > 0) {
    log(JSON.stringify({ status: "failed", failures }));
    app.exit(1);
    return;
  }
  log(
    JSON.stringify({
      status: "passed",
      checks: [
        "preload",
        "enter-navigate",
        "address-sync",
        "back",
        "page-viewport",
        "human-signals",
        "rehost-after-human-close",
      ],
      viewport: stage.view.getBounds(),
    }),
  );
  app.exit(0);
});
