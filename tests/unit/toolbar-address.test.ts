import { describe, expect, it } from "vitest";
import { normalizeAddress } from "../../src/shared/toolbar";

describe("normalizeAddress", () => {
  it("keeps absolute http and https urls", () => {
    expect(normalizeAddress("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeAddress("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  });

  it("adds https to bare hosts and trims input", () => {
    expect(normalizeAddress("  example.com  ")).toBe("https://example.com/");
    expect(normalizeAddress("example.com/path")).toBe("https://example.com/path");
  });

  it("rejects empty and non-web schemes", () => {
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress("javascript:alert(1)")).toBeNull();
    expect(normalizeAddress("file:///etc/passwd")).toBeNull();
    expect(normalizeAddress("not a url")).toBeNull();
  });
});
