import { BadRequest } from "./http";

/**
 * 会话可以逐项放开的页面权限；不点名的默认拒绝。
 * 能打开外部应用、读写文件系统、抓屏、碰硬件的权限不在此列：那些不是「网页自己能用」的范围。
 */
export const GRANTABLE_PERMISSIONS = [
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "geolocation",
  "idle-detection",
  "media",
  "midi",
  "midiSysex",
  "notifications",
  "pointerLock",
  "speaker-selection",
] as const;

export type GrantablePermission = (typeof GRANTABLE_PERMISSIONS)[number];

export function parsePermissions(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new BadRequest(`permissions 必须是字符串数组，可选值：${GRANTABLE_PERMISSIONS.join("、")}`);
  }
  const unknown = raw.find((item) => !(GRANTABLE_PERMISSIONS as readonly string[]).includes(item as string));
  if (unknown !== undefined) {
    throw new BadRequest(
      `permissions 含不可放开的权限：${JSON.stringify(unknown)}；可选值：${GRANTABLE_PERMISSIONS.join("、")}`,
    );
  }
  return [...new Set(raw as string[])];
}
