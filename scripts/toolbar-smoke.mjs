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
  const bar = stage.toolbar.view.webContents;
  const failures = [];

  try {
    await page.loadURL("data:text/html,<title>one</title><h1>one</h1>");
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
      checks: ["preload", "enter-navigate", "address-sync", "back", "page-viewport"],
      viewport: stage.view.getBounds(),
    }),
  );
  app.exit(0);
});
