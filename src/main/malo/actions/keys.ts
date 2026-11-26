export const SUPPORTED_KEY_NAMES: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => `F${n}`),
]);

export function isSupportedKey(key: string): boolean {
  return key.length === 1 || SUPPORTED_KEY_NAMES.has(key);
}
