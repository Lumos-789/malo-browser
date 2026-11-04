import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DemoError } from "../../src/shared/errors";
import type { Scene } from "../../src/shared/scene";
import {
  buildSecurityPolicy,
  decideDownload,
  decidePermission,
  isAllowedNavigation,
  resolveScenePath,
} from "../../src/main/security";

let tempRoot: string;
let sceneRoot: string;
let sceneReal: string;

const SCENE_TEXT_EXTENSIONS = ["html", "css", "js", "mjs", "png", "jpg", "jpeg", "svg", "webp", "woff2", "json", "txt", "md"];

function baseScene(overrides: Partial<Scene> = {}): Scene {
  return {
    schemaVersion: 1,
    id: "report-review",
    title: "Report Review",
    viewport: { width: 1280, height: 720 },
    profile: "demo",
    allow: [],
    permissions: [],
    resetPolicy: "reload",
    vars: {},
    steps: [{ id: "step-1", action: "wait", seconds: 1 }],
    rootDir: "/tmp/scene",
    ...overrides,
  };
}

async function expectDemoError(promise: Promise<unknown>, code: DemoError["code"]): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(DemoError);
  await promise.catch((error: DemoError) => expect(error.code).toBe(code));
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "malo-browser-security-"));
  sceneRoot = path.join(tempRoot, "scene");
  await mkdir(path.join(sceneRoot, "assets"), { recursive: true });
  await mkdir(path.join(sceneRoot, "folder.html"), { recursive: true });
  await mkdir(path.join(tempRoot, "outside"), { recursive: true });

  await writeFile(path.join(sceneRoot, "index.html"), "<!doctype html><title>scene</title>");
  await writeFile(path.join(sceneRoot, "assets", "logo.png"), "png");
  await writeFile(path.join(sceneRoot, "notes.md"), "# notes");
  await writeFile(path.join(tempRoot, "outside", "secret.html"), "<h1>secret</h1>");
  for (const extension of SCENE_TEXT_EXTENSIONS) {
    await writeFile(path.join(sceneRoot, `file.${extension}`), "x");
  }

  await symlink(path.join("..", "outside", "secret.html"), path.join(sceneRoot, "leak.html"));
  await symlink("index.html", path.join(sceneRoot, "inner.html"));
  sceneReal = await realpath(sceneRoot);
});

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("isAllowedNavigation", () => {
  it("allows a URL whose origin matches an allow entry", () => {
    expect(isAllowedNavigation("https://app.example.com/reports/1", ["https://app.example.com"])).toEqual({
      allowed: true,
      reason: "origin-match",
    });
  });

  it("allows sub-paths when the allow entry carries a path", () => {
    expect(isAllowedNavigation("https://app.example.com/other", ["https://app.example.com/app"]).allowed).toBe(true);
  });

  it("rejects a different host", () => {
    const decision = isAllowedNavigation("https://evil.example.com/", ["https://app.example.com"]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("origin-not-allowed");
  });

  it("rejects a different port", () => {
    expect(isAllowedNavigation("https://app.example.com:8443/page", ["https://app.example.com"]).allowed).toBe(false);
  });

  it("rejects a different protocol", () => {
    expect(isAllowedNavigation("http://app.example.com/page", ["https://app.example.com"]).allowed).toBe(false);
    expect(isAllowedNavigation("https://app.example.com/page", ["http://app.example.com"]).allowed).toBe(false);
  });

  it("normalizes scheme and host case", () => {
    expect(isAllowedNavigation("HTTPS://APP.Example.COM/Path", ["https://app.example.com"]).allowed).toBe(true);
    expect(isAllowedNavigation("https://app.example.com/Path", ["HTTPS://App.Example.Com"]).allowed).toBe(true);
  });

  it("treats explicit default ports as the same origin", () => {
    expect(isAllowedNavigation("https://app.example.com:443/page", ["https://app.example.com"]).allowed).toBe(true);
  });

  it("allows the declared demo scene root and its files", () => {
    const allow = ["demo://scene/report-review"];
    expect(isAllowedNavigation("demo://scene/report-review", allow)).toEqual({
      allowed: true,
      reason: "demo-scene-root",
    });
    expect(isAllowedNavigation("demo://scene/report-review/index.html", allow).allowed).toBe(true);
    expect(isAllowedNavigation("DEMO://SCENE/Report-Review/assets/app.js", allow).allowed).toBe(true);
  });

  it("rejects a demo URL for a different scene", () => {
    const decision = isAllowedNavigation("demo://scene/other-scene/index.html", ["demo://scene/report-review"]);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("demo-scene-root-not-allowed");
  });

  it("rejects invalid and non-web URLs", () => {
    expect(isAllowedNavigation("not a url", ["https://app.example.com"]).allowed).toBe(false);
    expect(isAllowedNavigation("", ["https://app.example.com"]).allowed).toBe(false);
    expect(isAllowedNavigation("/relative/page", ["https://app.example.com"]).allowed).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd", ["https://app.example.com"]).allowed).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", ["https://app.example.com"]).allowed).toBe(false);
  });

  it("rejects URLs that embed credentials", () => {
    expect(isAllowedNavigation("https://user:pass@app.example.com/", ["https://app.example.com"]).allowed).toBe(false);
  });

  it("fails loudly on a malformed allow entry", () => {
    expect(() => isAllowedNavigation("https://app.example.com/", ["example.com"])).toThrow(DemoError);
    expect(() => isAllowedNavigation("https://app.example.com/", ["file:///tmp"])).toThrow(DemoError);
  });
});

describe("resolveScenePath", () => {
  it("resolves files directly under the scene root", async () => {
    await expect(resolveScenePath(sceneRoot, "index.html")).resolves.toBe(path.join(sceneReal, "index.html"));
  });

  it("resolves nested assets", async () => {
    await expect(resolveScenePath(sceneRoot, "assets/logo.png")).resolves.toBe(path.join(sceneReal, "assets", "logo.png"));
  });

  it("accepts every whitelisted extension", async () => {
    for (const extension of SCENE_TEXT_EXTENSIONS) {
      await expect(resolveScenePath(sceneRoot, `file.${extension}`)).resolves.toBe(path.join(sceneReal, `file.${extension}`));
    }
  });

  it("rejects parent traversal", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "../outside/secret.html"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, "assets/../../outside/secret.html"), "E_NAV_BLOCKED");
  });

  it("rejects absolute paths", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "/etc/passwd"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, path.join(tempRoot, "outside", "secret.html")), "E_NAV_BLOCKED");
  });

  it("rejects URL-encoded traversal", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "%2e%2e/outside/secret.html"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, "%2E%2E%2Foutside%2Fsecret.html"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, "%252e%252e%252Foutside%252Fsecret.html"), "E_NAV_BLOCKED");
  });

  it("rejects NUL bytes, literal and encoded", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "index.html\0.png"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, "index%00.html"), "E_NAV_BLOCKED");
  });

  it("rejects non-whitelisted extensions", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "tool.exe"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, "scene.yaml"), "E_NAV_BLOCKED");
    await expectDemoError(resolveScenePath(sceneRoot, "README"), "E_NAV_BLOCKED");
  });

  it("rejects a symlink that escapes the scene root", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "leak.html"), "E_NAV_BLOCKED");
  });

  it("allows a symlink that stays inside the scene root", async () => {
    await expect(resolveScenePath(sceneRoot, "inner.html")).resolves.toBe(path.join(sceneReal, "index.html"));
  });

  it("reports a missing file as not found", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "missing.html"), "E_SCENE_NOT_FOUND");
  });

  it("rejects a directory even with an allowed extension", async () => {
    await expectDemoError(resolveScenePath(sceneRoot, "folder.html"), "E_SCENE_NOT_FOUND");
  });

  it("rejects a missing scene root and a relative root", async () => {
    await expectDemoError(resolveScenePath(path.join(tempRoot, "nope"), "index.html"), "E_SCENE_NOT_FOUND");
    await expectDemoError(resolveScenePath("scene", "index.html"), "E_SCENE_INVALID");
  });
});

describe("decidePermission", () => {
  it("denies every permission when nothing is declared", () => {
    expect(decidePermission("clipboard-read", [])).toEqual({
      allowed: false,
      reason: "permission-not-declared: clipboard-read",
    });
    expect(decidePermission("fullscreen", []).allowed).toBe(false);
  });

  it("allows a declared permission", () => {
    expect(decidePermission("clipboard-read", ["clipboard-read"])).toEqual({
      allowed: true,
      reason: "declared-permission: clipboard-read",
    });
    expect(decidePermission("fullscreen", ["fullscreen"]).allowed).toBe(true);
  });

  it("maps clipboard-write to Electron's clipboard-sanitized-write", () => {
    expect(decidePermission("clipboard-sanitized-write", ["clipboard-write"]).allowed).toBe(true);
    expect(decidePermission("clipboard-write", ["clipboard-sanitized-write"]).allowed).toBe(true);
  });

  it("matches declared permissions case-insensitively", () => {
    expect(decidePermission("FullScreen", ["fullscreen"]).allowed).toBe(true);
  });

  it("denies a permission that is not declared", () => {
    expect(decidePermission("geolocation", ["clipboard-read"]).allowed).toBe(false);
    expect(decidePermission("notifications", ["clipboard-read", "fullscreen"]).allowed).toBe(false);
  });

  it("denies unknown permission names even when declared", () => {
    expect(decidePermission("super-power", ["super-power"])).toEqual({
      allowed: false,
      reason: "unknown-permission: super-power",
    });
    expect(decidePermission("", [""]).allowed).toBe(false);
  });
});

describe("decideDownload", () => {
  it("cancels downloads by default", () => {
    expect(decideDownload({})).toEqual({ action: "cancel", reason: "downloads-not-declared" });
    expect(decideDownload({ sceneAllowed: false }).action).toBe("cancel");
  });

  it("allows only when the scene declares downloads", () => {
    expect(decideDownload({ sceneAllowed: true })).toEqual({ action: "allow", reason: "scene-allows-download" });
  });
});

describe("buildSecurityPolicy", () => {
  it("auto-adds the local demo scene root", () => {
    const policy = buildSecurityPolicy(baseScene({ file: "index.html", allow: ["https://app.example.com"] }));
    expect(policy.demoOrigin).toBe("demo://scene/report-review");
    expect(policy.allow).toEqual(expect.arrayContaining(["https://app.example.com", "demo://scene/report-review"]));
    expect(isAllowedNavigation("demo://scene/report-review/index.html", policy.allow).allowed).toBe(true);
  });

  it("auto-adds the scene url origin and normalizes entries", () => {
    const policy = buildSecurityPolicy(
      baseScene({ url: "https://APP.example.com/report", allow: ["https://cdn.example.com/assets/"] }),
    );
    expect(policy.allow.sort()).toEqual(["https://app.example.com", "https://cdn.example.com"]);
  });

  it("does not add a demo root for remote-only scenes", () => {
    const policy = buildSecurityPolicy(baseScene({ url: "https://app.example.com" }));
    expect(policy.allow).toEqual(["https://app.example.com"]);
  });

  it("keeps permissions canonical and de-duplicated", () => {
    const policy = buildSecurityPolicy(baseScene({ permissions: ["clipboard-sanitized-write", "clipboard-write", "fullscreen"] }));
    expect(policy.permissions).toEqual(["clipboard-write", "fullscreen"]);
  });

  it("defaults downloads off and honors record.downloads_allowed", () => {
    expect(buildSecurityPolicy(baseScene()).downloadsAllowed).toBe(false);
    expect(buildSecurityPolicy(baseScene({ record: { downloads_allowed: true } })).downloadsAllowed).toBe(true);
  });

  it("fails loudly on unsupported permissions, bad allow entries and bad flags", () => {
    expect(() => buildSecurityPolicy(baseScene({ permissions: ["camera-wormhole"] }))).toThrow(DemoError);
    expect(() => buildSecurityPolicy(baseScene({ allow: ["example.com"] }))).toThrow(DemoError);
    expect(() => buildSecurityPolicy(baseScene({ record: { downloads_allowed: "yes" } }))).toThrow(DemoError);
    expect(() => buildSecurityPolicy(baseScene({ id: "Bad Id" }))).toThrow(DemoError);
  });
});
