import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { DemoError } from "../../src/shared/errors";
import { SCENE_ACTIONS } from "../../src/shared/scene";
import {
  interpolateScene,
  listScenes,
  loadScene,
  parseScene,
  rawStepSchema,
  scriptSha256,
} from "../../src/main/scenes";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map((target) => rm(target, { recursive: true, force: true })),
  );
});

function baseScene(): Record<string, unknown> {
  return {
    schema_version: 1,
    id: "demo",
    title: "Demo Scene",
    url: "https://app.example.com/reports",
    viewport: { width: 1440, height: 900 },
    allow: ["https://cdn.example.com"],
    reset_policy: "reload",
    vars: { demo_user: "demo@example.com" },
    steps: [
      {
        action: "wait",
        seconds: 1,
        note: "wait for load",
      },
    ],
  };
}

function parseBase(raw: Record<string, unknown> = baseScene(), rootDir = "/tmp/scenes/demo") {
  return parseScene(raw, { rootDir, sceneId: "demo" });
}

function captureError(fn: () => unknown): DemoError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DemoError);
    return error as DemoError;
  }
  throw new Error("expected function to throw");
}

function sceneErrors(error: DemoError): string[] {
  const errors = error.details?.errors;
  expect(Array.isArray(errors)).toBe(true);
  return errors as string[];
}

describe("parseScene", () => {
  it("parses snake_case input into a camelCase Scene with defaults", () => {
    const scene = parseBase();

    expect(scene.schemaVersion).toBe(1);
    expect(scene.id).toBe("demo");
    expect(scene.viewport).toEqual({
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    expect(scene.profile).toBe("demo");
    expect(scene.resetPolicy).toBe("reload");
    expect(scene.allow).toEqual([
      "https://cdn.example.com",
      "https://app.example.com",
    ]);
    expect(scene.steps[0]).toMatchObject({
      id: "step-0",
      action: "wait",
      seconds: 1,
      note: "wait for load",
    });
  });

  it("accepts every protocol action and its documented parameters", () => {
    const raw = baseScene();
    raw.steps = [
      {
        id: "goto",
        action: "goto",
        url: "https://app.example.com/next",
        wait_until: "load",
        hold_ms: 0,
        wait_after_ms: 100,
        timeout_ms: 5000,
        on_error: "stop",
      },
      { action: "login", account_id: "work" },
      { action: "wait", seconds: 0.5, advance: "manual" },
      {
        action: "wait_for",
        selector: "#ready",
        state: "visible",
        timeout_ms: 2000,
      },
      { action: "wait_for_presenter" },
      {
        action: "click",
        data_demo_id: "go",
        button: "left",
        click_count: 1,
      },
      {
        action: "fill",
        selector: "#search",
        text: "risk",
        clear: true,
        key_events: true,
      },
      { action: "press", key: "Enter" },
      {
        action: "scroll",
        dx: 0,
        dy: 120,
        selector: "#list",
        behavior: "smooth",
      },
      {
        action: "highlight",
        selector: "#row",
        seconds: 1,
        color: "#ffcc00",
        optional: true,
      },
      {
        action: "spotlight",
        selector: "#row",
        padding: 8,
        dim: 0.5,
        seconds: 1,
      },
      {
        action: "annotate",
        selector: "#row",
        text: "high risk",
        position: "top",
        seconds: 1,
        until: "scene-end",
      },
      { action: "mask", selector: "#secret", mode: "blur", color: "#000000" },
      { action: "blackout", on: true },
      {
        action: "assert",
        visible: "#done",
        text: "done",
        value: "ok",
        url: "/reports",
        count: 1,
        timeout_ms: 1000,
      },
      { action: "scene", scene_id: "other" },
      { action: "set", name: "state", value: "ready" },
      { action: "note", text: "finished" },
      { action: "screenshot", path: "shots/final.png" },
    ];

    const scene = parseBase(raw);
    expect(scene.steps).toHaveLength(19);
    expect(scene.steps[0]).toMatchObject({
      waitUntil: "load",
      holdMs: 0,
      waitAfterMs: 100,
      timeoutMs: 5000,
      onError: "stop",
    });
    expect(scene.steps[1]).toMatchObject({ action: "login", accountId: "work" });
  });

  it("reports unknown fields at scene and step level", () => {
    const raw = baseScene();
    raw.unexpected = true;
    (raw.steps as Array<Record<string, unknown>>)[0].typo_field = 1;

    const error = captureError(() => parseBase(raw));
    const errors = sceneErrors(error);

    expect(error.code).toBe("E_SCENE_INVALID");
    expect(errors.some((entry) => entry.includes("scene.unexpected"))).toBe(true);
    expect(errors.some((entry) => entry.startsWith("steps[0]."))).toBe(true);
    expect(errors.some((entry) => entry.includes("typo_field"))).toBe(true);
    expect(error.message).toContain("typo_field");
  });

  it("accepts the documented target, key and scroll fields", () => {
    const raw = baseScene();
    raw.steps = [
      { action: "click", x: 640, y: 360 },
      { action: "highlight", selector: ".btn", seconds: 1 },
      { action: "spotlight", data_demo_id: "row-1" },
      { action: "mask", x: 10, y: 20, mode: "solid" },
      { action: "annotate", text: "note", x: 10, y: 20, position: "bottom" },
      // `fill` by target_text and by coordinates are both documented forms.
      { action: "fill", target_text: "Search", text: "risk" },
      { action: "fill", x: 12, y: 34, text: "risk" },
      { action: "press", key: "Enter", modifiers: 4 },
      { action: "scroll", dy: 200, behavior: "smooth" },
    ];

    const scene = parseBase(raw);
    expect(scene.steps).toHaveLength(9);
    expect(scene.steps[5].targetText).toBe("Search");
    expect(scene.steps[7].modifiers).toBe(4);
  });

  it("requires exactly one of url and file", () => {
    const both = baseScene();
    both.file = "index.html";
    expect(sceneErrors(captureError(() => parseBase(both))).join("\n")).toContain(
      "exactly one",
    );

    const neither = baseScene();
    delete neither.url;
    expect(
      sceneErrors(captureError(() => parseBase(neither))).join("\n"),
    ).toContain("exactly one");
  });

  it("rejects empty steps", () => {
    const raw = baseScene();
    raw.steps = [];
    expect(sceneErrors(captureError(() => parseBase(raw))).join("\n")).toContain(
      "steps",
    );
  });

  it("requires a target for click and reports the step index", () => {
    const raw = baseScene();
    raw.steps = [{ action: "click" }];

    const errors = sceneErrors(captureError(() => parseBase(raw)));
    expect(errors.some((entry) => entry.startsWith("steps[0]"))).toBe(true);
    expect(errors.join("\n")).toContain("data_demo_id");
  });

  it("requires account_id for login", () => {
    const raw = baseScene();
    raw.steps = [{ action: "login" }];

    expect(sceneErrors(captureError(() => parseBase(raw))).join("\n")).toContain(
      "login requires account_id",
    );
  });

  it("rejects file paths that are absolute or contain ..", () => {
    for (const file of ["../outside.html", "/etc/passwd", "assets/../../x.html"]) {
      const raw = baseScene();
      delete raw.url;
      raw.file = file;
      const errors = sceneErrors(captureError(() => parseBase(raw))).join("\n");
      expect(errors).toContain("scene.file");
    }
  });

  it("validates wait, fill, assert and viewport constraints", () => {
    const missingWait = baseScene();
    missingWait.steps = [{ action: "wait" }];
    expect(
      sceneErrors(captureError(() => parseBase(missingWait))).join("\n"),
    ).toContain("wait requires seconds");

    const badFill = baseScene();
    badFill.steps = [{ action: "fill", data_demo_id: "search", text: "" }];
    expect(
      sceneErrors(captureError(() => parseBase(badFill))).join("\n"),
    ).toContain("fill requires non-empty text");

    const badAssert = baseScene();
    badAssert.steps = [{ action: "assert" }];
    expect(
      sceneErrors(captureError(() => parseBase(badAssert))).join("\n"),
    ).toContain("assert requires at least one");

    const badViewport = baseScene();
    badViewport.viewport = { width: 100, height: 900 };
    expect(
      sceneErrors(captureError(() => parseBase(badViewport))).join("\n"),
    ).toContain("viewport.width");
  });

  it("rejects optional on non-visual actions", () => {
    const raw = baseScene();
    raw.steps = [{ action: "click", selector: "#go", optional: true }];
    expect(sceneErrors(captureError(() => parseBase(raw))).join("\n")).toContain(
      "optional",
    );
  });
});

describe("interpolateScene", () => {
  it("interpolates scene variables and environment values", () => {
    const raw = baseScene();
    raw.vars = {
      user: "demo",
      greeting: "Hello ${user} ${env:GREETING_TARGET}",
    };
    raw.steps = [
      { action: "wait", seconds: 1, note: "logged in as ${user}" },
    ];
    const scene = parseBase(raw);
    const resolved = interpolateScene(scene, { GREETING_TARGET: "world" });

    expect(resolved.vars.greeting).toBe("Hello demo world");
    expect(resolved.steps[0].note).toBe("logged in as demo");
    expect(scene.vars.greeting).toBe(
      "Hello ${user} ${env:GREETING_TARGET}",
    );
  });

  it("fails loudly when an environment variable is missing", () => {
    const raw = baseScene();
    raw.vars = { demo_password: "${env:DEMO_PASSWORD_MISSING}" };
    const scene = parseBase(raw);

    const error = captureError(() => interpolateScene(scene, {}));
    expect(error.code).toBe("E_SCENE_INVALID");
    expect(error.message).toContain("DEMO_PASSWORD_MISSING");
  });

  it("fails loudly on unknown variables and cycles", () => {
    const unknown = parseBase({
      ...baseScene(),
      steps: [{ action: "wait", seconds: 1, note: "${missing}" }],
    });
    expect(() => interpolateScene(unknown, {})).toThrow(/Unknown scene variable/);

    const cyclic = parseBase({
      ...baseScene(),
      vars: { a: "${b}", b: "${a}" },
    });
    expect(() => interpolateScene(cyclic, {})).toThrow(/Circular/);
  });
});

describe("scriptSha256", () => {
  it("is stable across rootDir and key order and ignores runtime keys", () => {
    const first = parseBase(baseScene(), "/tmp/scenes-a/demo");
    const reorderedRaw = Object.fromEntries(
      Object.entries(baseScene()).reverse(),
    );
    const second = parseBase(reorderedRaw, "/tmp/scenes-b/demo");

    expect(scriptSha256(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(scriptSha256(first)).toBe(scriptSha256(first));
    expect(scriptSha256(first)).toBe(scriptSha256(second));
  });

  it("changes when the scene definition changes", () => {
    const first = parseBase();
    const raw = baseScene();
    raw.title = "Changed";
    const second = parseBase(raw);

    expect(scriptSha256(first)).not.toBe(scriptSha256(second));
  });
});

describe("loadScene and listScenes", () => {
  it("lists valid and invalid scenes without failing the table", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demo-scenes-"));
    cleanups.push(root);

    const goodDir = path.join(root, "good");
    const badDir = path.join(root, "bad");
    const emptyDir = path.join(root, "empty");
    await mkdir(goodDir);
    await mkdir(badDir);
    await mkdir(emptyDir);

    const good = { ...baseScene(), id: "good", title: "Good Scene" };
    await writeFile(path.join(goodDir, "scene.yaml"), stringifyYaml(good));

    const bad = { ...baseScene(), id: "bad", title: "Bad Scene", steps: [] };
    await writeFile(path.join(badDir, "scene.yaml"), stringifyYaml(bad));

    const entries = await listScenes(root);
    expect(entries.map((entry) => entry.id)).toEqual(["bad", "empty", "good"]);

    const badEntry = entries.find((entry) => entry.id === "bad");
    expect(badEntry).toMatchObject({
      title: "Bad Scene",
      invalid: true,
    });
    expect(badEntry?.errors.length).toBeGreaterThan(0);

    const emptyEntry = entries.find((entry) => entry.id === "empty");
    expect(emptyEntry).toMatchObject({ invalid: true });
    expect(emptyEntry?.errors[0]).toContain("scene.yaml");

    const goodEntry = entries.find((entry) => entry.id === "good");
    expect(goodEntry).toMatchObject({
      title: "Good Scene",
      invalid: false,
      errors: [],
    });
  });

  it("loads a scene and reports missing scenes with E_SCENE_NOT_FOUND", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "demo-scenes-"));
    cleanups.push(root);
    const sceneDir = path.join(root, "demo");
    await mkdir(sceneDir);
    await writeFile(
      path.join(sceneDir, "scene.yaml"),
      stringifyYaml(baseScene()),
    );

    const scene = await loadScene(root, "demo");
    expect(scene.title).toBe("Demo Scene");
    expect(scene.rootDir).toBe(path.resolve(root, "demo"));

    await expect(loadScene(root, "missing")).rejects.toMatchObject({
      code: "E_SCENE_NOT_FOUND",
    });
    await expect(loadScene(root, "../escape")).rejects.toMatchObject({
      code: "E_SCENE_INVALID",
    });
  });
});

describe("scene.schema.json", () => {
  it("is valid JSON and keeps the action list in sync", async () => {
    const text = await readFile(
      path.join(process.cwd(), "schemas/scene.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(text) as {
      properties: Record<string, unknown>;
      $defs: { step: { properties: { action: { enum: string[] } } } };
    };

    expect(schema.properties.steps).toBeDefined();
    expect(schema.$defs.step.properties.action.enum).toEqual([...SCENE_ACTIONS]);
  });

  it("declares every step field the runtime schema accepts", async () => {
    const text = await readFile(
      path.join(process.cwd(), "schemas/scene.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(text) as {
      $defs: { step: { properties: Record<string, unknown> } };
    };
    // The published field contract must not drift from the zod schema: that is
    // exactly how `target_text`/`modifiers` became documented-but-rejected.
    const runtimeKeys = Object.keys(rawStepSchema.shape).sort();
    const publishedKeys = Object.keys(schema.$defs.step.properties).sort();
    expect(publishedKeys).toEqual(runtimeKeys);
  });
});
