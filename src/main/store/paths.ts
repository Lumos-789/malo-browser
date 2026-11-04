import path from "node:path";

export function recordingPath(root: string, sceneId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return path.join(root, "recordings", `${stamp}_${sceneId}`, "take-01.mp4");
}
