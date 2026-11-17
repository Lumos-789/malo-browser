import { readFileSync } from "node:fs";
import path from "node:path";

let cached: string | null = null;

/**
 * 包版本，用于客户端与 daemon 的握手。
 * src/main/malo/* 与 out/main/malo/* 到仓根都是三级，所以同一路径两边都成立。
 */
export function maloVersion(): string {
  if (cached !== null) return cached;
  const file = path.join(__dirname, "../../../package.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
  if (parsed.name !== "malo-browser" || typeof parsed.version !== "string") {
    throw new Error(`读不到 malo-browser 版本（${file}）：name=${parsed.name} version=${parsed.version}`);
  }
  cached = parsed.version;
  return cached;
}
