import { describe, expect, it } from "vitest";
import {
  buildAssertChecks,
  describeAssertFailure,
  type MaloAssertState,
} from "../../src/main/malo/assertions";

function state(overrides: Partial<MaloAssertState> = {}): MaloAssertState {
  return {
    url: "https://example.com/done",
    title: "Done",
    visible: null,
    hidden_visible: null,
    text: null,
    value: null,
    value_redacted: false,
    count: null,
    invalid_selector: null,
    ...overrides,
  };
}

describe("malo assertion checks", () => {
  it("passes visible, hidden, text, value, url and count together", () => {
    const checks = buildAssertChecks(
      {
        visible: "#done",
        hidden: "#spinner",
        text: "Saved",
        selector: "#name",
        value: "demo",
        url: "/done",
        count: 3,
      },
      state({ visible: true, hidden_visible: false, text: true, value: "demo", count: 3 }),
    );
    expect(checks.map((check) => check.kind)).toEqual([
      "visible",
      "hidden",
      "text",
      "value",
      "url",
      "count",
    ]);
    expect(checks.every((check) => check.ok)).toBe(true);
  });

  it("reports each failed check with expected and actual values", () => {
    const checks = buildAssertChecks(
      { visible: "#done", hidden: "#spinner", text: "Saved", url: "/done" },
      state({ visible: false, hidden_visible: true, text: false, url: "https://example.com/login" }),
    );
    expect(checks.filter((check) => !check.ok).map((check) => check.kind)).toEqual([
      "visible",
      "hidden",
      "text",
      "url",
    ]);
    const message = describeAssertFailure(checks);
    expect(message).toContain('visible expected true, got false');
    expect(message).toContain('hidden expected false, got true');
    expect(message).toContain('text expected "Saved", got false');
    expect(message).toContain("url expected \"/done\", got \"https://example.com/login\"");
  });

  it("treats a missing value target as a failed value check", () => {
    const checks = buildAssertChecks({ selector: "#name", value: "demo" }, state({ value: null }));
    expect(checks).toEqual([{ kind: "value", expected: "demo", actual: null, ok: false }]);
  });
});
