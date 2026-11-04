import { DemoError } from "../../shared/errors";
import type { Scene } from "../../shared/scene";
import { normalizeOrigin } from "./allowlist";

export type SecurityPolicy = {
  allow: string[];
  permissions: string[];
  downloadsAllowed: boolean;
  demoOrigin: string;
};

const PERMISSION_ALIASES: Readonly<Record<string, string>> = {
  "clipboard-read": "clipboard-read",
  "clipboard-write": "clipboard-write",
  "clipboard-sanitized-write": "clipboard-write",
  fullscreen: "fullscreen",
  notifications: "notifications",
  geolocation: "geolocation",
  media: "media",
  midi: "midi",
  "midi-sysex": "midi-sysex",
  midisysex: "midi-sysex",
  "pointer-lock": "pointer-lock",
  pointerlock: "pointer-lock",
  "open-external": "open-external",
  openexternal: "open-external",
  "display-capture": "display-capture",
  "keyboard-lock": "keyboard-lock",
  keyboardlock: "keyboard-lock",
  "idle-detection": "idle-detection",
  idledetection: "idle-detection",
  "storage-access": "storage-access",
  "top-level-storage-access": "top-level-storage-access",
  "window-management": "window-management",
  windowmanagement: "window-management",
  "speaker-selection": "speaker-selection",
  "file-system": "file-system",
  filesystem: "file-system",
  "media-key-system": "media-key-system",
  hid: "hid",
  serial: "serial",
  usb: "usb",
  bluetooth: "bluetooth",
};

const SCENE_ID = /^[a-z0-9-]+$/;

export function normalizePermission(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  return PERMISSION_ALIASES[key] ?? null;
}

export function decidePermission(
  requested: string,
  allowed: readonly string[],
): { allowed: boolean; reason: string } {
  const wanted = normalizePermission(requested);
  if (!wanted) return { allowed: false, reason: `unknown-permission: ${String(requested)}` };

  const granted = new Set<string>();
  for (const entry of allowed) {
    const permission = normalizePermission(entry);
    if (permission) granted.add(permission);
  }
  if (granted.has(wanted)) return { allowed: true, reason: `declared-permission: ${wanted}` };
  return { allowed: false, reason: `permission-not-declared: ${wanted}` };
}

export function decideDownload(options: { sceneAllowed?: boolean }): {
  action: "cancel" | "allow";
  reason: string;
} {
  if (options.sceneAllowed === true) return { action: "allow", reason: "scene-allows-download" };
  return { action: "cancel", reason: "downloads-not-declared" };
}

function normalizePermissionList(list: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    const permission = normalizePermission(entry);
    if (!permission) {
      throw new DemoError("E_SCENE_INVALID", `permissions[${index}] is not a supported permission: ${String(entry)}`);
    }
    if (seen.has(permission)) return;
    seen.add(permission);
    result.push(permission);
  });
  return result;
}

function readDownloadsAllowed(record: Scene["record"]): boolean {
  if (record === undefined || record === null) return false;
  if (typeof record !== "object" || Array.isArray(record)) {
    throw new DemoError("E_SCENE_INVALID", "record must be an object");
  }
  const value = (record as Record<string, unknown>).downloads_allowed;
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new DemoError("E_SCENE_INVALID", "record.downloads_allowed must be a boolean");
  }
  return value;
}

export function buildSecurityPolicy(scene: Scene): SecurityPolicy {
  if (!scene || typeof scene !== "object") {
    throw new DemoError("E_SCENE_INVALID", "scene must be an object");
  }
  if (typeof scene.id !== "string" || !SCENE_ID.test(scene.id)) {
    throw new DemoError("E_SCENE_INVALID", `scene id is invalid: ${String(scene.id)}`);
  }

  const allow = new Set<string>();
  const declared = scene.allow ?? [];
  if (!Array.isArray(declared)) throw new DemoError("E_SCENE_INVALID", "scene.allow must be an array");
  declared.forEach((entry, index) => {
    try {
      allow.add(normalizeOrigin(entry, `allow[${index}]`));
    } catch (error) {
      if (error instanceof DemoError) throw error;
      throw new DemoError("E_SCENE_INVALID", `allow[${index}] is invalid: ${String(entry)}`);
    }
  });

  if (typeof scene.url === "string" && scene.url.trim() !== "") {
    allow.add(normalizeOrigin(scene.url, "scene.url"));
  }

  const demoOrigin = `demo://scene/${scene.id}`;
  if (typeof scene.file === "string" && scene.file.trim() !== "") allow.add(demoOrigin);

  return {
    allow: [...allow],
    permissions: normalizePermissionList(scene.permissions ?? []),
    downloadsAllowed: readDownloadsAllowed(scene.record),
    demoOrigin,
  };
}
