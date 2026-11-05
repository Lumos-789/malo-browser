import { z } from "zod";
import { SCENE_ACTIONS, type SceneAction } from "../../shared/scene";

export const SCENE_ID_PATTERN = /^[a-z0-9-]+$/;

const actionSchema = z.enum(
  [...SCENE_ACTIONS] as [SceneAction, ...SceneAction[]],
);

const secondsSchema = z.number().min(0).max(3600);
const zeroToTenMinutesMs = z.number().int().min(0).max(600_000);
const timeoutMsSchema = z.number().int().min(1).max(600_000);

const targetFields = {
  data_demo_id: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
};

export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const parts = value.split(/[\\/]/);
  return parts.every((part) => part !== "..") && !parts.includes("");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function hasString(
  step: Record<string, unknown>,
  key: string,
): boolean {
  const value = step[key];
  return typeof value === "string" && value.trim().length > 0;
}

const VISUAL_ACTIONS = new Set<string>(["highlight", "spotlight", "annotate"]);

export const rawStepSchema = z
  .object({
    id: z.string().min(1).optional(),
    action: actionSchema,
    note: z.string().optional(),
    advance: z.enum(["auto", "manual"]).optional(),
    hold_ms: zeroToTenMinutesMs.optional(),
    wait_after_ms: zeroToTenMinutesMs.optional(),
    timeout_ms: timeoutMsSchema.optional(),
    optional: z.boolean().optional(),
    on_error: z.enum(["stop", "warn"]).optional(),

    ...targetFields,
    url: z.string().min(1).optional(),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional(),
    seconds: secondsSchema.optional(),
    state: z.enum(["visible", "hidden", "attached"]).optional(),

    button: z.enum(["left", "middle", "right"]).optional(),
    click_count: z.number().int().min(1).max(10).optional(),
    clear: z.boolean().optional(),
    key_events: z.boolean().optional(),
    key: z.string().min(1).optional(),
    modifiers: z.number().int().min(0).max(15).optional(),
    target_text: z.string().min(1).optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    behavior: z.enum(["auto", "instant", "smooth"]).optional(),

    color: z.string().min(1).optional(),
    padding: z.number().min(0).max(500).optional(),
    dim: z.number().min(0).max(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    position: z.enum(["top", "bottom", "left", "right"]).optional(),
    until: z.enum(["scene-end"]).optional(),
    mode: z.enum(["blur", "solid"]).optional(),
    on: z.boolean().optional(),

    visible: z.string().min(1).optional(),
    value: z.string().optional(),
    count: z.number().int().min(0).optional(),
    scene_id: z.string().min(1).optional(),
    account_id: z.string().regex(/^[a-z0-9-]+$/).optional(),
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const action = step.action;
    const issue = (field: string, message: string) => {
      ctx.addIssue({ code: "custom", path: [field], message });
    };
    const hasTargetField = () =>
      hasString(step, "data_demo_id") ||
      hasString(step, "selector") ||
      hasString(step, "text");
    // Coordinates are the documented last-resort target and resolveTarget
    // already supports them; the validator used to reject them anyway.
    const hasPoint = () =>
      typeof step.x === "number" && typeof step.y === "number";

    if (step.optional === true && !VISUAL_ACTIONS.has(action)) {
      issue("optional", "only visual actions may set optional: true");
    }

    switch (action) {
      case "goto":
        if (!hasString(step, "url")) issue("url", "goto requires url");
        break;
      case "login":
        if (!hasString(step, "account_id")) {
          issue("account_id", "login requires account_id");
        }
        break;
      case "wait":
        if (step.seconds === undefined) {
          issue("seconds", "wait requires seconds");
        }
        break;
      case "wait_for":
        if (
          !hasString(step, "selector") &&
          !hasString(step, "text") &&
          !hasString(step, "url")
        ) {
          issue(
            "selector",
            "wait_for requires selector, text or url",
          );
        }
        break;
      case "click":
      case "highlight":
      case "spotlight":
      case "mask":
        if (!hasTargetField() && !hasPoint()) {
          issue(
            "data_demo_id",
            `${action} requires data_demo_id, selector, text or x/y coordinates`,
          );
        }
        break;
      case "fill":
        if (
          !hasString(step, "data_demo_id") &&
          !hasString(step, "selector") &&
          !hasString(step, "target_text") &&
          !hasPoint()
        ) {
          issue(
            "data_demo_id",
            "fill requires data_demo_id, selector, target_text or x/y coordinates",
          );
        }
        if (!hasString(step, "text")) {
          issue("text", "fill requires non-empty text");
        }
        break;
      case "annotate": {
        if (!hasString(step, "text")) {
          issue("text", "annotate requires non-empty text");
        }
        const hasTarget =
          hasString(step, "data_demo_id") || hasString(step, "selector");
        if (!hasTarget && !hasPoint()) {
          issue(
            "data_demo_id",
            "annotate requires data_demo_id, selector or x/y coordinates",
          );
        }
        break;
      }
      case "press":
        if (!hasString(step, "key")) issue("key", "press requires key");
        break;
      case "blackout":
        if (step.on === undefined) issue("on", "blackout requires on");
        break;
      case "assert":
        if (
          step.visible === undefined &&
          step.text === undefined &&
          step.value === undefined &&
          step.url === undefined &&
          step.count === undefined
        ) {
          issue(
            "visible",
            "assert requires at least one of visible, text, value, url or count",
          );
        }
        break;
      case "scene":
        if (!hasString(step, "scene_id")) issue("scene_id", "scene requires scene_id");
        break;
      case "set":
        if (!hasString(step, "name")) issue("name", "set requires name");
        break;
      case "screenshot":
        if (!hasString(step, "path")) {
          issue("path", "screenshot requires path");
        } else if (
          typeof step.path === "string" &&
          !isSafeRelativePath(step.path)
        ) {
          issue(
            "path",
            "screenshot.path must be relative and must not contain ..",
          );
        }
        break;
      default:
        break;
    }
  });

export const rawSceneSchema = z
  .object({
    schema_version: z.literal(1),
    id: z.string().regex(SCENE_ID_PATTERN, "must match [a-z0-9-]+"),
    title: z.string().min(1),
    description: z.string().optional(),
    url: z
      .string()
      .min(1)
      .refine(isHttpUrl, "must be an absolute http(s) URL")
      .optional(),
    file: z
      .string()
      .min(1)
      .refine(
        isSafeRelativePath,
        "must be a relative path inside the scene directory without ..",
      )
      .optional(),
    viewport: z
      .object({
        width: z.number().int().min(800).max(3840),
        height: z.number().int().min(450).max(2160),
        device_scale_factor: z.number().min(0.5).max(4).optional(),
        mobile: z.boolean().optional(),
      })
      .strict(),
    profile: z.string().min(1).optional(),
    allow: z.array(z.string().min(1)).optional(),
    permissions: z.array(z.string().min(1)).optional(),
    reset_policy: z
      .enum(["reload", "clear-storage", "new-session"])
      .optional(),
    vars: z.record(z.string(), z.string()).optional(),
    steps: z.array(rawStepSchema).min(1),
    record: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type RawStep = z.infer<typeof rawStepSchema>;
export type RawScene = z.infer<typeof rawSceneSchema>;
