import { DemoError } from "../shared/errors";
import type { Scene } from "../shared/scene";
import { buildSecurityPolicy, type SecurityPolicy } from "./security";

export type StagePlan = {
  width: number;
  height: number;
  policy: SecurityPolicy;
  url: string;
};

export type StagePlanState = Pick<StagePlan, "width" | "height" | "policy">;

export type StagePlanDiff = {
  width: number;
  height: number;
  resized: boolean;
  policyChanged: boolean;
};

const MAX_STAGE_EDGE = 10_000;

export function buildStagePlan(scene: Scene): StagePlan {
  if (!scene || typeof scene !== "object") {
    throw new DemoError("E_SCENE_INVALID", "scene must be an object");
  }
  return {
    width: viewportEdge(scene.id, "width", scene.viewport?.width),
    height: viewportEdge(scene.id, "height", scene.viewport?.height),
    policy: buildSecurityPolicy(scene),
    url: sceneDisplayUrl(scene),
  };
}

export function diffStagePlan(current: StagePlanState | null, next: StagePlan): StagePlanDiff {
  return {
    width: next.width,
    height: next.height,
    resized: current === null || current.width !== next.width || current.height !== next.height,
    policyChanged: current === null || !sameSecurityPolicy(current.policy, next.policy),
  };
}

export function sameSecurityPolicy(left: SecurityPolicy, right: SecurityPolicy): boolean {
  return (
    left.demoOrigin === right.demoOrigin &&
    left.downloadsAllowed === right.downloadsAllowed &&
    sameStringSet(left.allow, right.allow) &&
    sameStringSet(left.permissions, right.permissions)
  );
}

/** First-visit order keeps multi-scene evidence stable and readable. */
export function recordSceneVisit(visited: readonly string[], sceneId: string): string[] {
  const id = typeof sceneId === "string" ? sceneId.trim() : "";
  if (id === "") {
    throw new DemoError("E_SCENE_INVALID", "sceneId 不能为空");
  }
  return visited.includes(id) ? [...visited] : [...visited, id];
}

export function sceneDisplayUrl(scene: Scene): string {
  if (scene.url) return scene.url;
  if (!scene.file) throw new DemoError("E_SCENE_INVALID", `场景 ${scene.id} 既没有 url 也没有 file`);
  const encoded = scene.file
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `demo://scene/${encodeURIComponent(scene.id)}/${encoded}`;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((entry, index) => entry === b[index]);
}

function viewportEdge(sceneId: string, edge: "width" | "height", value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_STAGE_EDGE) {
    throw new DemoError(
      "E_SCENE_INVALID",
      `场景 ${sceneId} viewport.${edge} 必须是 1..${MAX_STAGE_EDGE} 的整数：${String(value)}`,
      { sceneId },
    );
  }
  return value;
}
