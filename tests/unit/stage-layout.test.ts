import { describe, expect, it } from "vitest";
import { DemoError } from "../../src/shared/errors";
import type { Scene } from "../../src/shared/scene";
import { isAllowedNavigation } from "../../src/main/security";
import {
  buildStagePlan,
  diffStagePlan,
  recordSceneVisit,
  sameSecurityPolicy,
} from "../../src/main/stage-layout";

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    schemaVersion: 1,
    id: "scene-a",
    title: "Scene A",
    url: "https://a.example.com/dashboard",
    viewport: { width: 1440, height: 900 },
    profile: "demo",
    allow: ["https://cdn.example.com"],
    permissions: [],
    resetPolicy: "reload",
    vars: {},
    steps: [{ id: "wait", action: "wait", seconds: 0.2 }],
    rootDir: "/tmp/scene-a",
    ...overrides,
  };
}

describe("buildStagePlan", () => {
  it("uses the scene viewport and derives the security policy from the scene", () => {
    const plan = buildStagePlan(makeScene());

    expect(plan.width).toBe(1440);
    expect(plan.height).toBe(900);
    expect(plan.url).toBe("https://a.example.com/dashboard");
    expect(plan.policy.allow.sort()).toEqual(["https://a.example.com", "https://cdn.example.com"]);
    expect(plan.policy.downloadsAllowed).toBe(false);
  });

  it("builds a demo url for file scenes", () => {
    const plan = buildStagePlan(
      makeScene({
        id: "local-demo",
        url: undefined,
        file: "pages/报告 首页.html",
        allow: [],
        rootDir: "/tmp/local",
      }),
    );

    expect(plan.url).toBe("demo://scene/local-demo/pages/%E6%8A%A5%E5%91%8A%20%E9%A6%96%E9%A1%B5.html");
    expect(plan.policy.allow).toEqual(["demo://scene/local-demo"]);
  });

  it("fails loudly on an unusable viewport", () => {
    expect(() => buildStagePlan(makeScene({ viewport: { width: 0, height: 900 } }))).toThrow(DemoError);
    expect(() => buildStagePlan(makeScene({ viewport: { width: 1440.5, height: 900 } }))).toThrow(
      /viewport\.width/,
    );
  });
});

describe("scene switching", () => {
  const first = makeScene();
  const second = makeScene({
    id: "scene-b",
    title: "Scene B",
    url: "https://b.example.com/report",
    viewport: { width: 1920, height: 1080 },
    allow: ["https://b-cdn.example.com"],
    permissions: ["clipboard-read"],
    record: { downloads_allowed: true },
  });

  it("plans a resize and policy swap when the next scene differs", () => {
    const before = buildStagePlan(first);
    const after = buildStagePlan(second);
    const diff = diffStagePlan(before, after);

    expect(diff).toEqual({ width: 1920, height: 1080, resized: true, policyChanged: true });
    expect(after.policy.downloadsAllowed).toBe(true);
    expect(after.policy.permissions).toEqual(["clipboard-read"]);
    expect(sameSecurityPolicy(before.policy, after.policy)).toBe(false);
  });

  it("keeps the stage untouched when dimensions and policy match", () => {
    const before = buildStagePlan(first);
    const same = buildStagePlan(makeScene({ id: "scene-a", title: "Scene A again" }));

    expect(diffStagePlan(before, same)).toEqual({
      width: 1440,
      height: 900,
      resized: false,
      policyChanged: false,
    });
  });

  it("compares allow and permission lists regardless of declaration order", () => {
    const left = buildStagePlan(makeScene({ allow: ["https://b.example.com", "https://a.example.com"] }));
    const right = buildStagePlan(makeScene({ allow: ["https://a.example.com", "https://b.example.com"] }));

    expect(sameSecurityPolicy(left.policy, right.policy)).toBe(true);
    expect(diffStagePlan(left, right).policyChanged).toBe(false);
  });

  it("navigates according to the policy of the active scene only", () => {
    const firstPolicy = buildStagePlan(first).policy;
    const secondPolicy = buildStagePlan(second).policy;
    const target = "https://b.example.com/report";

    expect(isAllowedNavigation(target, firstPolicy.allow).allowed).toBe(false);
    expect(isAllowedNavigation(target, secondPolicy.allow).allowed).toBe(true);
    expect(isAllowedNavigation("https://a.example.com/dashboard", firstPolicy.allow).allowed).toBe(true);
    expect(isAllowedNavigation("https://a.example.com/dashboard", secondPolicy.allow).allowed).toBe(false);
  });
});

describe("recordSceneVisit", () => {
  it("accumulates scene ids in first-visit order", () => {
    const empty: string[] = [];
    const withFirst = recordSceneVisit(empty, "scene-a");
    const withSecond = recordSceneVisit(withFirst, "scene-b");

    expect(empty).toEqual([]);
    expect(withFirst).toEqual(["scene-a"]);
    expect(withSecond).toEqual(["scene-a", "scene-b"]);
  });

  it("does not duplicate a scene that was already visited", () => {
    const visited = recordSceneVisit(recordSceneVisit([], "scene-a"), "scene-b");
    const again = recordSceneVisit(visited, "scene-a");

    expect(again).toEqual(["scene-a", "scene-b"]);
    expect(again).not.toBe(visited);
  });

  it("rejects an empty scene id", () => {
    expect(() => recordSceneVisit([], "  ")).toThrow(/sceneId/);
  });
});
