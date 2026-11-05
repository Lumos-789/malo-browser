import { DemoError } from "../../shared/errors";

/**
 * Scenes may interpolate environment variables, but only from their own
 * namespace: a scene file is often third-party content, and reading arbitrary
 * process env (cloud keys, tokens) into a URL or form field would let the scene
 * exfiltrate it. `password_env` for the account login path is separate.
 */
export const SCENE_ENV_PREFIX = "SCENE_";

export function assertSceneEnvName(name: string): void {
  if (!name.startsWith(SCENE_ENV_PREFIX)) {
    throw new DemoError(
      "E_SCENE_INVALID",
      `环境变量 ${name} 不能用于场景插值：只允许 ${SCENE_ENV_PREFIX}* 前缀`,
      { details: { variable: name, prefix: SCENE_ENV_PREFIX } },
    );
  }
}

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new DemoError("E_SCENE_INVALID", `环境变量缺失：${name}`, {
      details: { variable: name },
    });
  }
  return value;
}

/** Reads `name` from process.env, enforcing the SCENE_ namespace. */
export function sceneEnvValue(name: string): string {
  assertSceneEnvName(name);
  return requireValue(name, process.env[name]);
}

/** Same rule, but against a caller-supplied env map (used by the scene interpolator). */
export function sceneEnvFrom(
  name: string,
  env: Record<string, string | undefined>,
): string {
  assertSceneEnvName(name);
  return requireValue(name, env[name]);
}
