import { DemoError } from "../../shared/errors";

export type NavigationDecision = { allowed: boolean; reason: string };

const NETWORK_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_SCHEMES = new Set([...NETWORK_SCHEMES, "demo:"]);

function demoSceneRoot(url: URL): string | null {
  if (url.protocol !== "demo:") return null;
  const sceneId = url.pathname.split("/").find((segment) => segment.length > 0);
  if (!url.hostname || !sceneId) return null;
  return `demo://${url.hostname.toLowerCase()}/${sceneId.toLowerCase()}`;
}

/**
 * Canonical navigation key: URL origin for http(s), `demo://<host>/<scene-id>`
 * scene root for demo URLs. Credentials and unsupported schemes are rejected.
 */
export function normalizeOrigin(raw: string, label = "origin"): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new DemoError("E_SCENE_INVALID", `${label} must be a non-empty string`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DemoError("E_SCENE_INVALID", `${label} is not a valid URL: ${raw}`);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new DemoError("E_SCENE_INVALID", `${label} scheme is not supported: ${raw}`);
  }
  if (url.username || url.password) {
    throw new DemoError("E_SCENE_INVALID", `${label} must not contain credentials: ${raw}`);
  }
  if (url.protocol === "demo:") {
    const root = demoSceneRoot(url);
    if (!root) throw new DemoError("E_SCENE_INVALID", `${label} is not a demo scene URL: ${raw}`);
    return root;
  }
  return url.origin;
}

export function isAllowedNavigation(rawUrl: string, allow: readonly string[]): NavigationDecision {
  const allowed = new Set(allow.map((entry) => normalizeOrigin(entry, "allow entry")));

  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { allowed: false, reason: "invalid-url: empty" };
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { allowed: false, reason: `invalid-url: ${rawUrl}` };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { allowed: false, reason: `scheme-not-allowed: ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { allowed: false, reason: "credentials-not-allowed" };
  }

  if (url.protocol === "demo:") {
    const root = demoSceneRoot(url);
    if (!root) return { allowed: false, reason: `invalid-demo-url: ${rawUrl}` };
    if (allowed.has(root)) return { allowed: true, reason: "demo-scene-root" };
    return { allowed: false, reason: `demo-scene-root-not-allowed: ${root}` };
  }

  if (allowed.has(url.origin)) return { allowed: true, reason: "origin-match" };
  return { allowed: false, reason: `origin-not-allowed: ${url.origin}` };
}
