export type MaloToolDefinition = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

/** 在哪个 iframe 里操作：frame 是 snapshot.frames 的下标，不给就是顶层页面。 */
const FRAME_TARGET_PROPERTIES = {
  frame: {
    type: "integer",
    minimum: 0,
    description: "Index into snapshot.frames: act inside that iframe. Omit for the top-level page.",
  },
  frame_url: {
    type: "string",
    description: "Guard: the iframe's URL must contain this substring, otherwise the page changed and the index is stale.",
  },
} as const;

export const MALO_TOOLS: MaloToolDefinition[] = [
  {
    name: "navigate",
    description: "Open an HTTP(S) URL and wait for the page to settle.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http/https URL." },
        timeout_ms: { type: "integer", minimum: 100, maximum: 120000, default: 30000 },
        settle_ms: {
          type: "integer",
          minimum: 0,
          maximum: 15000,
          default: 6000,
          description: "Maximum time to wait for DOM/network stability.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "observe",
    description: "Return lightweight page state; request a PNG screenshot when needed.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["light", "screenshot"], default: "light" },
        max_chars: { type: "integer", minimum: 0, maximum: 20000, default: 2000 },
        clip_selector: {
          type: "string",
          description:
            "CSS selector; when set with mode=screenshot, capture only that element's box (document coordinates).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "snapshot",
    description:
      "Return structured page content: visible text, headings, links, buttons, inputs, forms, tables, landmarks, role-based widgets, frames and interactive elements. Pass sections to get only the lists you need (the others come back empty); in interactive[].rect, x/y is the element center and left/top the corner, ready for click/drag.",
    input_schema: {
      type: "object",
      properties: {
        max_chars: { type: "integer", minimum: 0, maximum: 30000, default: 8000 },
        max_items: { type: "integer", minimum: 1, maximum: 500, default: 120 },
        sections: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Only collect these lists: text, headings, links, buttons, inputs, selects, forms, tables, landmarks, interactive, widgets, frames, dialogs, messages.",
        },
        frame_depth: {
          type: "integer",
          minimum: 0,
          maximum: 3,
          default: 1,
          description:
            "How many iframe levels to read content from. frames[] lists every visible iframe with its index and box; each entry's content is a nested snapshot (its rects are relative to that iframe's own viewport). 0 lists iframes without reading them. To act inside one, pass its index as frame.",
        },
        max_frames: {
          type: "integer",
          minimum: 0,
          maximum: 50,
          default: 4,
          description: "How many iframes to read content from at most; frames_truncated tells you when more were left out.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description:
      "Click an element by CSS selector, by visible text (substring match, innermost visible element), or click viewport coordinates.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to click; when combined with text, it scopes the text search instead.",
        },
        text: {
          type: "string",
          description: "Visible text to click (substring match, innermost visible element wins).",
        },
        nth: { type: "integer", minimum: 1, default: 1, description: "Which text match to click, 1-based." },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
        click_count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
        ...FRAME_TARGET_PROPERTIES,
      },
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description:
      "Focus an input and replace its contents with text, then read the element value back: if the page swallowed the input (controlled components can), JS-focus and native-setter fallbacks run, and a still-missing value fails with E_FILL_NOT_LANDED instead of a false success.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", default: true },
        verify: {
          type: "boolean",
          default: true,
          description: "Read the value back after filling. Turn off only for pages that rewrite input.",
        },
        ...FRAME_TARGET_PROPERTIES,
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "drag",
    description:
      "Press the left button at from, move in interpolated steps, release at to — for sliders, crop boxes and other components that listen to pointer/mouse sequences.",
    input_schema: {
      type: "object",
      properties: {
        from_x: { type: "number" },
        from_y: { type: "number" },
        to_x: { type: "number" },
        to_y: { type: "number" },
        steps: { type: "integer", minimum: 1, maximum: 100, default: 12 },
      },
      required: ["from_x", "from_y", "to_x", "to_y"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_file",
    description:
      "Set files on an input[type=file]. The input may be visually hidden: click the site's upload button first when the page needs it.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the input[type=file] element." },
        files: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Absolute paths on the host running the browser.",
        },
        ...FRAME_TARGET_PROPERTIES,
      },
      required: ["selector", "files"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description:
      "Press a key: a single character, or Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, Space, ArrowUp/Down/Left/Right, F1-F12. Cmd+A/C/V/X/Z map to editing commands; other Meta chords are rejected. Keyboard input goes to the focused element wherever it is.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        modifiers: {
          type: "integer",
          minimum: 0,
          maximum: 15,
          default: 0,
          description: "Bitmask, add the keys you want: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8.",
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description:
      "Type text one character at a time into the focused element (a newline sends Enter). Use it for editors, mention or autocomplete boxes that listen for key events; use fill to replace a field's value in one go.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: 5000 },
        delay_ms: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "hover",
    description: "Move the pointer over an element or viewport coordinates.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        ...FRAME_TARGET_PROPERTIES,
      },
      additionalProperties: false,
    },
  },
  {
    name: "select",
    description: "Choose an option in a native select element by value or visible label.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
        label: { type: "string" },
        ...FRAME_TARGET_PROPERTIES,
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "focus",
    description: "Focus an element without clicking it.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        ...FRAME_TARGET_PROPERTIES,
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description:
      "Send a mouse wheel delta. The wheel lands at the viewport center, so it scrolls the main content instead of a fixed sidebar in a corner; pass x/y to aim at a particular scroll container.",
    input_schema: {
      type: "object",
      properties: {
        dx: { type: "number", default: 0 },
        dy: { type: "number", default: 0 },
        x: { type: "number", description: "Wheel position in viewport coordinates (give both x and y)." },
        y: { type: "number" },
        ...FRAME_TARGET_PROPERTIES,
      },
      additionalProperties: false,
    },
  },
  {
    name: "scroll_into_view",
    description: "Scroll an element into the center of the viewport.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        ...FRAME_TARGET_PROPERTIES,
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "extract",
    description:
      "Extract text, HTML, selected attributes, or layout rects (mode=rect: x/y is the element center, ready for click/drag coordinates) from elements matching a CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        mode: { type: "string", enum: ["text", "html", "attributes", "rect"], default: "text" },
        attributes: { type: "array", items: { type: "string" } },
        max_chars: { type: "integer", minimum: 0, maximum: 2000000, default: 4000 },
        all: { type: "boolean", default: true },
        ...FRAME_TARGET_PROPERTIES,
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for",
    description: "Wait for a selector or visible text.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        state: { type: "string", enum: ["attached", "visible", "hidden"], default: "visible" },
        timeout_ms: { type: "integer", minimum: 0, maximum: 120000, default: 10000 },
        human: {
          type: "boolean",
          description:
            "Wait until the human clicks 完成 (Done) on the session window's toolbar. Pair it with watch: show the window, let the human work, then wait_for human to pick the handoff back up.",
        },
        ...FRAME_TARGET_PROPERTIES,
      },
      additionalProperties: false,
    },
  },
  {
    name: "assert",
    description:
      "Check page expectations and return a pass/fail verdict. Conditions are ANDed and retried until timeout_ms. HTTP 200 always means the check ran: read result.ok (false = assertion failed) plus result.checks and result.error.details.checks for expected/actual. Use url for routing, visible/hidden for elements, text for visible copy, value for form state, and count for element totals.",
    input_schema: {
      type: "object",
      properties: {
        visible: { type: "string", description: "CSS selector that must exist and be visible." },
        hidden: { type: "string", description: "CSS selector that must be missing or invisible." },
        text: { type: "string", description: "Visible text that must appear, optionally scoped by selector." },
        selector: {
          type: "string",
          description: "Scope for text, the target for value, or the target for count.",
        },
        value: { type: "string", description: "Exact value expected on the selector element." },
        url: { type: "string", description: "Substring expected in the current URL." },
        count: { type: "integer", minimum: 0, description: "Expected number of selector matches." },
        timeout_ms: {
          type: "integer",
          minimum: 0,
          maximum: 120000,
          default: 5000,
          description: "How long to retry before failing.",
        },
        ...FRAME_TARGET_PROPERTIES,
      },
      additionalProperties: false,
    },
  },
  {
    name: "history",
    description: "Go back, go forward, or reload the session page.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["back", "forward", "reload"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "run_steps",
    description:
      "Run browser tools as one deterministic case. Each step is a tool call object such as {\"type\":\"click\",\"selector\":\"#save\"}; steps execute in order, stop at the first failure by default, and the run is written to the session artifacts directory as JSON.",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            description: "One tool call with a type field plus that tool's arguments.",
          },
        },
        stop_on_failure: { type: "boolean", default: true },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "sleep",
    description: "Wait for a fixed number of milliseconds.",
    input_schema: {
      type: "object",
      properties: {
        ms: { type: "integer", minimum: 0, maximum: 120000 },
      },
      required: ["ms"],
      additionalProperties: false,
    },
  },
  {
    name: "events",
    description:
      "Read session events after a sequence number. Returns events, next_after (the cursor for the next poll) and dropped (how many events since your cursor were overwritten before you read them; 0 means nothing was missed). Events are also appended to the session's events_log file.",
    input_schema: {
      type: "object",
      properties: {
        after: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "network_capture",
    description:
      "Set or inspect this session's response-body capture subscription. Non-empty url_prefixes replace the subscription and enable CDP Network capture; [] clears it and disables capture. Omit url_prefixes to inspect only. Bodies stay in daemon memory, never in logs or evidence, and the subscription is private to this session.",
    input_schema: {
      type: "object",
      properties: {
        url_prefixes: {
          type: "array",
          items: { type: "string", description: "URL prefix such as https://api.example.com/v1/." },
          description:
            "Replace the subscription with these URL prefixes; [] clears it. Omit to inspect only.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "responses",
    description:
      "Query responses captured after subscribing with network_capture. Records are ordered by seq; use after as a cursor. A body_error of pending means the body is still queued, so poll again; the record shape carries url/status/mime_type/resource_type plus the raw body.",
    input_schema: {
      type: "object",
      properties: {
        url_prefix: { type: "string", description: "Only return URLs starting with this prefix." },
        after: { type: "integer", minimum: 0, default: 0, description: "Return records with seq greater than this." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "watch",
    description:
      "Show or hide the session window for a human. The window appears inactive and never steals focus. focus=true is refused unless the daemon runs with --allow-focus; a human who wants the window in front clicks it or its Dock icon.",
    input_schema: {
      type: "object",
      properties: {
        show: { type: "boolean", default: true },
        focus: { type: "boolean", default: false },
        width: { type: "integer", minimum: 640, maximum: 3840 },
        height: { type: "integer", minimum: 480, maximum: 2160 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "login",
    description:
      "Log in with one-shot credentials or hand off to a human for QR/login. Credentials are used in memory only and are never stored in events or returned.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["auto", "password", "watch"], default: "auto" },
        username: { type: "string" },
        password: { type: "string", description: "One-shot secret; not persisted." },
        username_selector: { type: "string" },
        password_selector: { type: "string" },
        submit_selector: { type: "string" },
        success_url_contains: { type: "string" },
        success_selector: { type: "string" },
        error_selector: { type: "string" },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 600000, default: 30000 },
        focus: {
          type: "boolean",
          default: false,
          description: "Only used in watch mode; refused unless the daemon runs with --allow-focus.",
        },
        keep_visible: {
          type: "boolean",
          default: false,
          description: "Keep the watch window visible after success.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "profiles",
    description:
      "List, preview or clear persistent login profiles. A profile keeps cookies and storage across sessions and daemon restarts. prune returns the profiles not used for at least min_idle_days (dry run unless apply=true). Clearing or pruning a profile that still has live sessions is refused.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "clear", "prune"], default: "list" },
        name: { type: "string", description: "Required when action=clear." },
        min_idle_days: {
          type: "number",
          minimum: 0,
          description: "Required when action=prune: profiles unused for at least this many days are candidates.",
        },
        apply: {
          type: "boolean",
          default: false,
          description: "prune only: true deletes the candidates, false only lists them.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "close",
    description: "Close this session and release its isolated browser resources.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

export const MALO_TOOL_NAMES = new Set(MALO_TOOLS.map((tool) => tool.name));

/** observe 是否支持按元素截图（clip_selector）。 */
function observeSupportsClip(): boolean {
  const observe = MALO_TOOLS.find((tool) => tool.name === "observe");
  return observe !== undefined && "clip_selector" in observe.input_schema.properties;
}

/** POST /v1/leases 的请求字段；broker 的校验与能力清单都以它为准。 */
export const MALO_LEASE_REQUEST = {
  agent_id: { type: "string" },
  holder: { type: "string", maxLength: 128 },
} as const;

function leasesSupportHolder(): boolean {
  return "holder" in MALO_LEASE_REQUEST;
}

/**
 * 能力清单：随工具 schema 自动推导，别手写维护。
 * 客户端（如 yewu-shot）拿它做启动前校验，缺能力就早失败，
 * 而不是跑到第 N 行才发现。
 */
export const MALO_FEATURES: string[] = [
  ...(observeSupportsClip() ? ["observe.screenshot_clip"] : []),
  ...(leasesSupportHolder() ? ["lease.holder"] : []),
];
