import { createHash } from "node:crypto";
import { DemoError } from "../../shared/errors";
import type { Scene } from "../../shared/scene";
import { sceneEnvFrom } from "./env";

const PLACEHOLDER = /\$\{([^}]+)\}/g;

const RUNTIME_KEYS = new Set([
  "rootDir",
  "outputPath",
  "outputDir",
  "startedAt",
  "endedAt",
  "elapsedMs",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function interpolateError(scene: Scene, message: string): DemoError {
  return new DemoError("E_SCENE_INVALID", message, {
    sceneId: scene.id,
    details: { errors: [message] },
  });
}

export function interpolateScene(
  scene: Scene,
  env: Record<string, string | undefined> = process.env,
): Scene {
  const sceneVars = scene.vars ?? {};

  const resolveString = (input: string, stack: string[]): string =>
    input.replace(PLACEHOLDER, (_match, expression: string) => {
      const token = expression.trim();
      if (token.length === 0) {
        throw interpolateError(scene, "Empty interpolation expression");
      }
      if (token.startsWith("env:")) {
        const name = token.slice("env:".length).trim();
        if (name.length === 0) {
          throw interpolateError(scene, "Empty environment variable name");
        }
        try {
          return sceneEnvFrom(name, env);
        } catch (error) {
          throw interpolateError(
            scene,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return resolveVariable(token, stack);
    });

  const resolveVariable = (name: string, stack: string[]): string => {
    if (stack.includes(name)) {
      throw interpolateError(
        scene,
        `Circular scene variable reference: ${[...stack, name].join(" -> ")}`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(sceneVars, name)) {
      throw interpolateError(scene, `Unknown scene variable "${name}"`);
    }
    return resolveString(sceneVars[name], [...stack, name]);
  };

  const map = (value: unknown): unknown => {
    if (typeof value === "string") {
      return resolveString(value, []);
    }
    if (Array.isArray(value)) {
      return value.map(map);
    }
    if (isPlainObject(value)) {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (key === "rootDir" || entry === undefined) continue;
        output[key] = map(entry);
      }
      return output;
    }
    return value;
  };

  const mapped = map(scene) as Scene;
  return { ...mapped, rootDir: scene.rootDir };
}

function stripRuntime(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRuntime);
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (RUNTIME_KEYS.has(key) || entry === undefined) continue;
      output[key] = stripRuntime(entry);
    }
    return output;
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalize(value[key]);
    }
    return output;
  }
  return value;
}

export function scriptSha256(scene: Scene): string {
  const canonical = canonicalize(stripRuntime(scene));
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}
