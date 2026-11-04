#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const base = process.env.DEMO_CONTROL_URL ?? "http://127.0.0.1:7317";
const token = process.env.DEMO_CONTROL_TOKEN ?? "";
const sceneId = process.argv[2] ?? "report-review";

if (!token) {
  console.error("DEMO_CONTROL_TOKEN 未设置：从 <out>/control.json 读取 token 后再跑");
  process.exit(2);
}

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    throw new Error(`${method} ${path} failed ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function command(cmd, args = {}) {
  const payload = await call("POST", "/command", { cmd, args });
  return payload.result;
}

const health = await call("GET", "/health");
if (health.status !== "ok") throw new Error(`health ${JSON.stringify(health)}`);

const initial = await call("GET", "/state");
console.log(`state scenes=${initial.scenes?.length ?? 0} displays=${initial.displays?.length ?? 0}`);

await command("scene.load", { sceneId });
await command("recorder.start", {});
await command("run.start", { mode: "record" });
await command("recorder.stop", {});

const final = await call("GET", "/state");
const output = final.recorder.outputPath;
if (!output) throw new Error("录制结束后没有 outputPath");
const evidence = JSON.parse(await readFile(output.replace(/\.mp4$/i, ".evidence.json"), "utf8"));
if (evidence.status !== "passed") throw new Error(`evidence status=${evidence.status}`);

console.log(JSON.stringify({
  ok: true,
  scene: evidence.scene.id,
  scenes: evidence.run.scene_ids ?? [evidence.scene.id],
  video: output,
  durationS: evidence.video?.duration_s,
  frames: evidence.video?.frames,
  evidenceStatus: evidence.status,
}, null, 2));
