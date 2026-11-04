import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DemoError } from "../../shared/errors";
import type { Scene, SceneStep } from "../../shared/scene";
import {
  isSafeRelativePath,
  rawSceneSchema,
  SCENE_ID_PATTERN,
  type RawScene,
  type RawStep,
} from "./scene-schema";

export type ParseSceneOptions = {
  rootDir: string;
  sceneId: string;
};

export type SceneListEntry = {
  id: string;
  title: string;
  path: string;
  invalid: boolean;
  errors: string[];
};

type CollectedError = {
  stepIndex: number;
  text: string;
  sequence: number;
};

type IssueLike = {
  path: PropertyKey[];
  message: string;
  code: string;
  keys?: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function formatPath(parts: PropertyKey[]): string {
  const startsAtSteps = parts[0] === "steps";
  let output = startsAtSteps ? "steps" : "scene";
  for (let index = startsAtSteps ? 1 : 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (typeof part === "number") {
      output += `[${part}]`;
    } else {
      output += `.${String(part)}`;
    }
  }
  return output;
}

function stepIndexOf(parts: PropertyKey[]): number {
  const position = parts.indexOf("steps");
  if (position < 0) return -1;
  const candidate = parts[position + 1];
  return typeof candidate === "number" ? candidate : -1;
}

function collectZodIssues(
  issues: IssueLike[],
  target: CollectedError[],
): void {
  for (const issue of issues) {
    const stepIndex = stepIndexOf(issue.path);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys ?? []) {
        target.push({
          stepIndex,
          text: `${formatPath(issue.path)}.${key}: unknown field`,
          sequence: target.length,
        });
      }
      continue;
    }
    target.push({
      stepIndex,
      text: `${formatPath(issue.path)}: ${issue.message}`,
      sequence: target.length,
    });
  }
}

function mapStep(raw: RawStep, index: number): SceneStep {
  const step: SceneStep = {
    id: raw.id ?? `step-${index}`,
    action: raw.action,
  };
  const assign = (key: string, value: unknown): void => {
    if (value !== undefined) step[key] = value;
  };

  assign("note", raw.note);
  assign("advance", raw.advance);
  assign("holdMs", raw.hold_ms);
  assign("waitAfterMs", raw.wait_after_ms);
  assign("timeoutMs", raw.timeout_ms);
  assign("optional", raw.optional);
  assign("onError", raw.on_error);
  assign("dataDemoId", raw.data_demo_id);
  assign("selector", raw.selector);
  assign("text", raw.text);
  assign("url", raw.url);
  assign("waitUntil", raw.wait_until);
  assign("seconds", raw.seconds);
  assign("state", raw.state);
  assign("button", raw.button);
  assign("clickCount", raw.click_count);
  assign("clear", raw.clear);
  assign("keyEvents", raw.key_events);
  assign("key", raw.key);
  assign("dx", raw.dx);
  assign("dy", raw.dy);
  assign("behavior", raw.behavior);
  assign("color", raw.color);
  assign("padding", raw.padding);
  assign("dim", raw.dim);
  assign("x", raw.x);
  assign("y", raw.y);
  assign("position", raw.position);
  assign("until", raw.until);
  assign("mode", raw.mode);
  assign("on", raw.on);
  assign("visible", raw.visible);
  assign("value", raw.value);
  assign("count", raw.count);
  assign("sceneId", raw.scene_id);
  assign("accountId", raw.account_id);
  assign("name", raw.name);
  assign("path", raw.path);

  return step;
}

function mapScene(raw: RawScene, rootDir: string): Scene {
  const allow = [...(raw.allow ?? [])];
  if (raw.url !== undefined) {
    const origin = new URL(raw.url).origin;
    if (!allow.includes(origin)) allow.push(origin);
  }

  return {
    schemaVersion: 1,
    id: raw.id,
    title: raw.title,
    description: raw.description,
    url: raw.url,
    file: raw.file,
    viewport: {
      width: raw.viewport.width,
      height: raw.viewport.height,
      deviceScaleFactor: raw.viewport.device_scale_factor ?? 1,
      mobile: raw.viewport.mobile ?? false,
    },
    profile: raw.profile ?? "demo",
    allow,
    permissions: raw.permissions ?? [],
    resetPolicy: raw.reset_policy ?? "reload",
    vars: raw.vars ?? {},
    steps: raw.steps.map(mapStep),
    ...(raw.record === undefined ? {} : { record: raw.record }),
    rootDir,
  };
}

export function parseScene(raw: unknown, options: ParseSceneOptions): Scene {
  const rootDir = path.resolve(options.rootDir);
  const errors: CollectedError[] = [];
  const push = (stepIndex: number, text: string): void => {
    errors.push({ stepIndex, text, sequence: errors.length });
  };

  if (!SCENE_ID_PATTERN.test(options.sceneId)) {
    push(
      -1,
      `scene.id: scene directory "${options.sceneId}" must match [a-z0-9-]+`,
    );
  }

  const candidate = isPlainObject(raw) ? raw : undefined;
  if (candidate !== undefined) {
    const present = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(candidate, key) &&
      candidate[key] !== undefined &&
      candidate[key] !== null;

    if (present("url") === present("file")) {
      push(-1, 'scene: exactly one of "url" or "file" is required');
    }

    if (typeof candidate.id === "string" && candidate.id !== options.sceneId) {
      push(
        -1,
        `scene.id: "${candidate.id}" must match scene directory "${options.sceneId}"`,
      );
    }

    if (
      typeof candidate.file === "string" &&
      isSafeRelativePath(candidate.file)
    ) {
      const resolved = path.resolve(rootDir, candidate.file);
      const relative = path.relative(rootDir, resolved);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        push(-1, "scene.file: must resolve inside the scene directory");
      }
    }
  }

  const parsed = rawSceneSchema.safeParse(raw);
  if (!parsed.success) {
    collectZodIssues(parsed.error.issues as IssueLike[], errors);
  }
  const parsedScene = parsed.success ? parsed.data : null;

  if (errors.length > 0) {
    const messages = errors
      .slice()
      .sort(
        (left, right) =>
          left.stepIndex - right.stepIndex ||
          left.sequence - right.sequence,
      )
      .map((error) => error.text);
    throw new DemoError(
      "E_SCENE_INVALID",
      `Scene "${options.sceneId}" is invalid: ${messages.length} error(s) — ${messages.join("; ")}`,
      {
        sceneId: options.sceneId,
        details: { errors: messages },
      },
    );
  }

  if (parsedScene === null) {
    const message = `Scene "${options.sceneId}" failed validation without an error`;
    throw new DemoError("E_SCENE_INVALID", message, {
      sceneId: options.sceneId,
      details: { errors: [message] },
    });
  }

  return mapScene(parsedScene, rootDir);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

function assertSceneId(sceneId: string): void {
  if (!SCENE_ID_PATTERN.test(sceneId)) {
    const message = `scene.id: scene id "${sceneId}" must match [a-z0-9-]+`;
    throw new DemoError("E_SCENE_INVALID", message, {
      sceneId,
      details: { errors: [message] },
    });
  }
}

export async function loadScene(
  scenesRoot: string,
  sceneId: string,
): Promise<Scene> {
  assertSceneId(sceneId);
  const root = path.resolve(scenesRoot);
  const rootDir = path.join(root, sceneId);
  const relative = path.relative(root, rootDir);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    const message = `scene.id: "${sceneId}" resolves outside the scenes root`;
    throw new DemoError("E_SCENE_INVALID", message, {
      sceneId,
      details: { errors: [message] },
    });
  }

  const scenePath = path.join(rootDir, "scene.yaml");
  let text: string;
  try {
    text = await readFile(scenePath, "utf8");
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DemoError(
        "E_SCENE_NOT_FOUND",
        `Scene "${sceneId}" not found at ${scenePath}`,
        { sceneId, details: { path: scenePath } },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new DemoError(
      "E_SCENE_INVALID",
      `Failed to read ${scenePath}: ${detail}`,
      {
        sceneId,
        details: { errors: [`scene.yaml: ${detail}`] },
      },
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `scene.yaml: ${detail}`;
    throw new DemoError("E_SCENE_INVALID", `Scene "${sceneId}" is invalid`, {
      sceneId,
      details: { errors: [message] },
    });
  }

  return parseScene(raw, { rootDir, sceneId });
}

function errorMessages(error: unknown): string[] {
  if (error instanceof DemoError) {
    const details = error.details?.errors;
    if (
      Array.isArray(details) &&
      details.every((entry): entry is string => typeof entry === "string")
    ) {
      return details;
    }
    return [error.message];
  }
  return [error instanceof Error ? error.message : String(error)];
}

function titleOf(raw: unknown, fallback: string): string {
  if (
    isPlainObject(raw) &&
    typeof raw.title === "string" &&
    raw.title.trim().length > 0
  ) {
    return raw.title;
  }
  return fallback;
}

export async function listScenes(
  scenesRoot: string,
): Promise<SceneListEntry[]> {
  const root = path.resolve(scenesRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new DemoError(
        "E_SCENE_NOT_FOUND",
        `Scenes root not found at ${root}`,
        { details: { path: root } },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new DemoError(
      "E_SCENE_INVALID",
      `Failed to read scenes root ${root}: ${detail}`,
      { details: { errors: [detail] } },
    );
  }

  const sceneIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const scenes: SceneListEntry[] = [];
  for (const id of sceneIds) {
    const rootDir = path.join(root, id);
    const scenePath = path.join(rootDir, "scene.yaml");
    let text: string;
    try {
      text = await readFile(scenePath, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      scenes.push({
        id,
        title: id,
        path: scenePath,
        invalid: true,
        errors: [`scene.yaml: ${detail}`],
      });
      continue;
    }

    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      scenes.push({
        id,
        title: id,
        path: scenePath,
        invalid: true,
        errors: [`scene.yaml: ${detail}`],
      });
      continue;
    }

    try {
      const scene = parseScene(raw, { rootDir, sceneId: id });
      scenes.push({
        id,
        title: scene.title,
        path: scenePath,
        invalid: false,
        errors: [],
      });
    } catch (error) {
      scenes.push({
        id,
        title: titleOf(raw, id),
        path: scenePath,
        invalid: true,
        errors: errorMessages(error),
      });
    }
  }

  return scenes;
}
