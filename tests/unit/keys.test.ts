import { describe, expect, it } from "vitest";
import {
  keyDefinition,
  keyEventText,
  isSupportedKey,
  MODIFIERS,
  NAMED_KEY_NAMES,
} from "../../src/main/keys";

describe("key definitions", () => {
  it("gives every named key the virtual key code that pages listen for", () => {
    expect(keyDefinition("Enter")).toEqual({ key: "Enter", code: "Enter", keyCode: 13 });
    expect(keyDefinition("Tab").keyCode).toBe(9);
    expect(keyDefinition("Escape").keyCode).toBe(27);
    expect(keyDefinition("Backspace").keyCode).toBe(8);
    expect(keyDefinition("ArrowDown").keyCode).toBe(40);
    expect(keyDefinition("PageUp").keyCode).toBe(33);
    expect(keyDefinition("F5").keyCode).toBe(116);
    expect(keyDefinition("F12").keyCode).toBe(123);
    expect(keyDefinition("Space")).toEqual({ key: " ", code: "Space", keyCode: 32 });
  });

  it("maps single characters to key, code and key code", () => {
    expect(keyDefinition("a")).toEqual({ key: "a", code: "KeyA", keyCode: 65 });
    expect(keyDefinition("Z")).toEqual({ key: "Z", code: "KeyZ", keyCode: 90 });
    expect(keyDefinition("7")).toEqual({ key: "7", code: "Digit7", keyCode: 55 });
    // 非 ASCII 字符没有键码，靠 text 输入
    expect(keyDefinition("中")).toEqual({ key: "中", code: "", keyCode: 0 });
  });

  it("types text only when no command modifier is held", () => {
    expect(keyEventText(keyDefinition("a"), 0)).toBe("a");
    expect(keyEventText(keyDefinition("a"), MODIFIERS.shift)).toBe("A");
    expect(keyEventText(keyDefinition("Enter"), 0)).toBe("\r");
    expect(keyEventText(keyDefinition("Enter"), MODIFIERS.shift)).toBe("\r");
    expect(keyEventText(keyDefinition("a"), MODIFIERS.ctrl)).toBeUndefined();
    expect(keyEventText(keyDefinition("a"), MODIFIERS.meta | MODIFIERS.shift)).toBeUndefined();
    expect(keyEventText(keyDefinition("ArrowDown"), 0)).toBeUndefined();
  });

  it("accepts single characters and the named keys only", () => {
    expect(isSupportedKey("x")).toBe(true);
    expect(isSupportedKey("中")).toBe(true);
    expect(isSupportedKey("F12")).toBe(true);
    expect(isSupportedKey("Return")).toBe(false);
    expect(isSupportedKey("ab")).toBe(false);
    expect(NAMED_KEY_NAMES).toHaveLength(27);
  });
});
