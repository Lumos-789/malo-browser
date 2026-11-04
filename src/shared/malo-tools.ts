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
      },
      additionalProperties: false,
    },
  },
  {
    name: "snapshot",
    description:
      "Return structured page content: visible text, headings, links, buttons, inputs, forms, tables, landmarks, frames and interactive elements.",
    input_schema: {
      type: "object",
      properties: {
        max_chars: { type: "integer", minimum: 0, maximum: 30000, default: 8000 },
        max_items: { type: "integer", minimum: 1, maximum: 500, default: 120 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click an element by CSS selector, or click viewport coordinates.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "middle", "right"], default: "left" },
        click_count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "fill",
    description: "Focus an input and replace its contents with text.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        clear: { type: "boolean", default: true },
      },
      required: ["selector", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a key. Cmd+A/C/V/X/Z map to editing commands; other Meta chords are rejected.",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string" },
        modifiers: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["key"],
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
      properties: { selector: { type: "string" } },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the page by a delta.",
    input_schema: {
      type: "object",
      properties: {
        dx: { type: "number", default: 0 },
        dy: { type: "number", default: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scroll_into_view",
    description: "Scroll an element into the center of the viewport.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "extract",
    description:
      "Extract text, HTML or selected attributes from elements matching a CSS selector.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        mode: { type: "string", enum: ["text", "html", "attributes"], default: "text" },
        attributes: { type: "array", items: { type: "string" } },
        max_chars: { type: "integer", minimum: 0, maximum: 20000, default: 4000 },
        all: { type: "boolean", default: true },
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
    description: "Read session events after a sequence number.",
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
      "Show or hide the session window for a human. Defaults to an inactive window that does not steal focus; use focus=true only when the human explicitly needs the foreground.",
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
          description: "Only used in watch mode; true may take the foreground.",
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
      "List or clear persistent login profiles. A profile keeps cookies and storage across sessions and daemon restarts; clearing a profile that still has live sessions is refused.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "clear"], default: "list" },
        name: { type: "string", description: "Required when action=clear." },
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
