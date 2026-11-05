import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerDemoProtocol } from "../../src/main/demo-protocol";

type Handler = (request: { url: string }) => Promise<Response>;

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

async function scenesFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "malo-demo-protocol-"));
  cleanups.push(root);
  const scenes = path.join(root, "scenes");
  await mkdir(path.join(scenes, "ok"), { recursive: true });
  await writeFile(path.join(scenes, "ok", "index.html"), "<h1>ok</h1>");
  await mkdir(path.join(root, "private"), { recursive: true });
  await writeFile(path.join(root, "private", "credential.json"), '{"secret":true}');
  return scenes;
}

function sessionFor(scenesRoot: string): Handler {
  let captured: Handler | null = null;
  const session = {
    protocol: {
      handle: (_scheme: string, handler: Handler) => {
        captured = handler;
      },
    },
  };
  registerDemoProtocol(session as never, scenesRoot);
  if (!captured) throw new Error("handler was not registered");
  return captured;
}

describe("demo protocol", () => {
  it("serves a file inside the scene directory", async () => {
    const scenes = await scenesFixture();
    const handler = sessionFor(scenes);
    const response = await handler({ url: "demo://scene/ok/index.html" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>ok</h1>");
  });

  it("rejects a scene id that would move the containment root", async () => {
    const scenes = await scenesFixture();
    const handler = sessionFor(scenes);
    const response = await handler({
      url: "demo://scene/..%2Fprivate%2Fcredential.json",
    });

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("E_SCENE_INVALID");
    expect(body).not.toContain("secret");
  });

  it("does not echo the resolved filesystem path on failure", async () => {
    const scenes = await scenesFixture();
    const handler = sessionFor(scenes);
    const response = await handler({ url: "demo://scene/ok/missing.html" });

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("E_SCENE_NOT_FOUND");
    expect(body).not.toContain(scenes);
    expect(body).not.toContain("/private/");
  });
});
