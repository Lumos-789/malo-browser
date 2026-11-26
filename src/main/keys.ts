/**
 * 键事件定义。页面只认 `keyCode`/`which` 的老代码依赖 windowsVirtualKeyCode：
 * 回车 13、Tab 9、方向键 37-40……缺了它们，这些页面收不到正确的键。
 */
export type KeyDefinition = {
  key: string;
  code: string;
  keyCode: number;
};

export const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const name = `F${index + 1}`;
      return [name, { key: name, code: name, keyCode: 112 + index }];
    }),
  ),
};

export const NAMED_KEY_NAMES: readonly string[] = Object.keys(NAMED_KEYS);

export function isSupportedKey(key: string): boolean {
  return [...key].length === 1 || key in NAMED_KEYS;
}

export function keyDefinition(key: string): KeyDefinition {
  const named = NAMED_KEYS[key];
  if (named) return named;
  const [char] = [...key];
  const upper = char.toUpperCase();
  const ascii = upper.charCodeAt(0) < 128;
  const code = char === " " ? "Space"
    : /^[a-z]$/i.test(char) ? `Key${upper}`
    : /^[0-9]$/.test(char) ? `Digit${char}`
    : "";
  return { key: char, code, keyCode: ascii ? upper.charCodeAt(0) : 0 };
}

/** 这个键在给定修饰键下会不会输入字符：会的话要带 text 发 keyDown，否则发 rawKeyDown。 */
export function keyEventText(definition: KeyDefinition, modifiers: number): string | undefined {
  if (modifiers & (MODIFIERS.alt | MODIFIERS.ctrl | MODIFIERS.meta)) return undefined;
  if (definition === NAMED_KEYS.Enter) return "\r";
  if (definition.key.length !== 1) return undefined;
  return modifiers & MODIFIERS.shift ? definition.key.toUpperCase() : definition.key;
}
