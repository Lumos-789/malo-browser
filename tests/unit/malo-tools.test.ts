import { describe, expect, it, vi } from "vitest";
import { DemoError } from "../../src/shared/errors";
import { MALO_TOOLS, MALO_TOOL_NAMES } from "../../src/shared/malo-tools";
import type { MaloRunReport } from "../../src/shared/malo";
import {
  assertFailureResult,
  invokeMaloTool,
  type MaloToolSession,
} from "../../src/main/malo/tools";

function fakeSession(): MaloToolSession {
  return {
    navigate: vi.fn(async (url: string) => ({ url, title: "", body_text: "" })),
    observe: vi.fn(async () => ({ url: "", title: "", body_text: "" })),
    snapshot: vi.fn(async () => ({ url: "", title: "", text: "hello", links: [], truncated: {} })),
    extract: vi.fn(async () => ({
      selector: "#x",
      mode: "text",
      count: 1,
      matches: [],
      truncated: false,
    })),
    assertExpectations: vi.fn(async (input: { visible?: string }) => ({
      ok: true as const,
      passed: true as const,
      checks: input.visible
        ? [{ kind: "visible" as const, expected: true, actual: true, ok: true }]
        : [],
      url: "",
      title: "",
      waited_ms: 0,
    })),
    saveRunReport: vi.fn(async () => "/tmp/run.json"),
    act: vi.fn(async (action: { type: string }) => ({
      action: action.type,
      detail: "ok",
      observation: { url: "", title: "", body_text: "" },
    })),
    watch: vi.fn(async () => ({
      visible: true,
      focused: false,
      url: "",
      title: "",
      window: "shown",
    })),
    login: vi.fn(async (input: { mode?: string }) => ({
      mode: input.mode === "watch" ? "watch" : "password",
      ok: true,
      reason: "success",
      final_url: "",
      title: "",
      credentials_used: input.mode !== "watch",
      attempts: 1,
      observation: { url: "", title: "", body_text: "" },
    })),
    networkCapture: vi.fn(async (input: { url_prefixes?: string[] } = {}) => ({
      url_prefixes: input.url_prefixes ?? [],
      captured: 0,
    })),
    responses: vi.fn(async () => ({ responses: [], has_more: false })),
    eventsAfter: vi.fn(() => []),
    close: vi.fn(async () => undefined),
  };
}

describe("malo-browser tool manifest", () => {
  it("publishes unique, object-shaped schemas for agent tools", () => {
    const names = MALO_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(MALO_TOOL_NAMES.has("snapshot")).toBe(true);
    expect(MALO_TOOL_NAMES.has("extract")).toBe(true);
    expect(MALO_TOOL_NAMES.has("history")).toBe(true);
    for (const tool of MALO_TOOLS) {
      expect(tool.input_schema.type).toBe("object");
      expect(typeof tool.input_schema.properties).toBe("object");
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it("routes tool calls to page operations", async () => {
    const session = fakeSession();
    await invokeMaloTool("navigate", { url: "https://example.com", settle_ms: 100 }, session);
    expect(session.navigate).toHaveBeenCalledWith("https://example.com", 30_000, 100);

    await invokeMaloTool("snapshot", { max_chars: 100, max_items: 5 }, session);
    expect(session.snapshot).toHaveBeenCalledWith(100, 5);

    await invokeMaloTool(
      "assert",
      { visible: "#done", text: "Saved", url: "/done", timeout_ms: 300 },
      session,
    );
    expect(session.assertExpectations).toHaveBeenCalledWith({
      visible: "#done",
      hidden: undefined,
      text: "Saved",
      selector: undefined,
      value: undefined,
      url: "/done",
      count: undefined,
      timeout_ms: 300,
    });

    await invokeMaloTool("click", { selector: "#go" }, session);
    expect(session.act).toHaveBeenCalledWith({ selector: "#go", type: "click" });

    await invokeMaloTool("close", {}, session);
    expect(session.close).toHaveBeenCalledOnce();

    await invokeMaloTool("watch", { focus: false }, session);
    expect(session.watch).toHaveBeenCalledWith({
      show: true,
      focus: false,
      width: undefined,
      height: undefined,
    });

    await invokeMaloTool(
      "login",
      { mode: "password", username: "demo", password: "secret" },
      session,
    );
    expect(session.login).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "password",
        username: "demo",
        password: "secret",
        focus: false,
        keep_visible: false,
      }),
    );
  });

  it("fails loud for bad arguments and unknown tools", async () => {
    await expect(invokeMaloTool("navigate", {}, fakeSession())).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
    await expect(invokeMaloTool("assert", {}, fakeSession())).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
    await expect(invokeMaloTool("assert", { value: "x" }, fakeSession())).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
    await expect(invokeMaloTool("teleport", {}, fakeSession())).rejects.toBeInstanceOf(DemoError);
    expect(MALO_TOOLS.length).toBeGreaterThanOrEqual(16);
  });

  it("publishes network capture schemas with typed prefixes and a bounded window", () => {
    const captureTool = MALO_TOOLS.find((tool) => tool.name === "network_capture");
    expect(captureTool).toBeDefined();
    const prefixes = captureTool!.input_schema.properties.url_prefixes as {
      type: string;
      items: { type: string };
    };
    expect(prefixes.type).toBe("array");
    expect(prefixes.items.type).toBe("string");
    expect(captureTool!.input_schema.additionalProperties).toBe(false);

    const responsesTool = MALO_TOOLS.find((tool) => tool.name === "responses");
    expect(responsesTool).toBeDefined();
    expect(responsesTool!.input_schema.properties.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
    });
    expect(responsesTool!.input_schema.properties.after).toMatchObject({
      type: "integer",
      minimum: 0,
      default: 0,
    });
    expect(responsesTool!.input_schema.additionalProperties).toBe(false);
  });

  it("dispatches subscriptions and response windows to the session", async () => {
    const session = fakeSession();
    await invokeMaloTool(
      "network_capture",
      { url_prefixes: ["https://api.example.com/v1/"] },
      session,
    );
    expect(session.networkCapture).toHaveBeenCalledWith({
      url_prefixes: ["https://api.example.com/v1/"],
    });

    await invokeMaloTool("network_capture", {}, session);
    expect(session.networkCapture).toHaveBeenLastCalledWith({ url_prefixes: undefined });

    await invokeMaloTool(
      "responses",
      { url_prefix: "https://api.example.com/v1/", after: 7, limit: 10 },
      session,
    );
    expect(session.responses).toHaveBeenCalledWith({
      url_prefix: "https://api.example.com/v1/",
      after: 7,
      limit: 10,
    });

    await invokeMaloTool("responses", {}, session);
    expect(session.responses).toHaveBeenLastCalledWith({
      url_prefix: undefined,
      after: 0,
      limit: 50,
    });

    for (const args of [
      { url_prefixes: "https://api.example.com/" },
      { url_prefixes: [42] },
      { url_prefixes: [""] },
    ]) {
      await expect(invokeMaloTool("network_capture", args, session)).rejects.toMatchObject({
        code: "E_BAD_REQUEST",
      });
    }
    await expect(
      invokeMaloTool("responses", { limit: 201 }, session),
    ).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(
      invokeMaloTool("responses", { after: -1 }, session),
    ).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });

  it("propagates a capture subsystem failure instead of returning an empty list", async () => {
    const session = fakeSession();
    session.responses = vi.fn(async () => {
      throw new DemoError("E_CAPTURE_UNAVAILABLE", "Network.enable 失败：quota exceeded");
    });
    await expect(invokeMaloTool("responses", {}, session)).rejects.toMatchObject({
      code: "E_CAPTURE_UNAVAILABLE",
    });
  });

  it("runs a step list in order and returns a bound report", async () => {
    const session = fakeSession();
    const { result } = await invokeMaloTool(
      "run_steps",
      {
        steps: [
          { type: "navigate", url: "https://example.com" },
          { type: "click", selector: "#go" },
          { type: "assert", visible: "#done" },
        ],
      },
      session,
    );

    expect(session.navigate).toHaveBeenCalledOnce();
    expect(session.act).toHaveBeenCalledOnce();
    expect(session.assertExpectations).toHaveBeenCalledOnce();
    expect(session.saveRunReport).toHaveBeenCalledOnce();
    const report = result as MaloRunReport;
    expect(report.ok).toBe(true);
    expect(report.failed_step).toBeNull();
    expect(report.steps.map((step) => step.type)).toEqual(["navigate", "click", "assert"]);
    expect(report.report_path).toBe("/tmp/run.json");
  });

  it("stops at the first failure by default", async () => {
    const session = fakeSession();
    session.act = vi.fn(async () => {
      throw new DemoError("E_SELECTOR_NOT_FOUND", "no #missing");
    });
    const { result } = await invokeMaloTool(
      "run_steps",
      {
        steps: [
          { type: "navigate", url: "https://example.com" },
          { type: "click", selector: "#missing" },
          { type: "click", selector: "#never" },
        ],
      },
      session,
    );
    const report = result as MaloRunReport;
    expect(report.ok).toBe(false);
    expect(report.failed_step).toBe(1);
    expect(report.steps).toHaveLength(2);
    expect(report.steps[1].error?.code).toBe("E_SELECTOR_NOT_FOUND");
    expect(session.act).toHaveBeenCalledOnce();
  });

  it("rejects nested or session-control steps", async () => {
    const session = fakeSession();
    for (const type of ["run_steps", "close", "watch", "profiles", "network_capture", "responses"]) {
      await expect(
        invokeMaloTool("run_steps", { steps: [{ type }] }, session),
      ).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    }
    await expect(invokeMaloTool("run_steps", { steps: [] }, session)).rejects.toMatchObject({
      code: "E_BAD_REQUEST",
    });
    await expect(
      invokeMaloTool("run_steps", { steps: [{ type: "teleport" }] }, session),
    ).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });
});

describe("assert verdicts", () => {
  const failedChecks = [
    { kind: "visible" as const, expected: true, actual: false, ok: false },
    { kind: "text" as const, expected: "Saved", actual: false, ok: false },
  ];

  function assertionError(): DemoError {
    return new DemoError("E_ASSERTION_FAILED", "断言失败：visible expected true, got false", {
      url: "https://example.com/done",
      selector: "#done",
      screenshotPath: "/tmp/artifacts/failure-1.png",
      details: { checks: failedChecks, waited_ms: 5001 },
    });
  }

  it("turns E_ASSERTION_FAILED into an ok:false verdict with checks and screenshot", () => {
    const verdict = assertFailureResult(assertionError());
    expect(verdict).toMatchObject({
      ok: false,
      passed: false,
      url: "https://example.com/done",
      waited_ms: 5001,
      screenshot: "/tmp/artifacts/failure-1.png",
      checks: failedChecks,
      error: { code: "E_ASSERTION_FAILED" },
    });
    expect(verdict?.error.details).toMatchObject({
      checks: failedChecks,
      waited_ms: 5001,
      screenshotPath: "/tmp/artifacts/failure-1.png",
    });
  });

  it("leaves non-assert errors on their transport status", () => {
    expect(assertFailureResult(new DemoError("E_BAD_REQUEST", "assert 至少需要一个断言条件"))).toBeNull();
    expect(assertFailureResult(new Error("boom"))).toBeNull();
    expect(assertFailureResult(null)).toBeNull();
  });

  it("keeps a nested assert failure a failed run_steps step", async () => {
    const session = fakeSession();
    session.assertExpectations = vi.fn(async () => {
      throw assertionError();
    });
    const { result } = await invokeMaloTool(
      "run_steps",
      { steps: [{ type: "assert", visible: "#done" }] },
      session,
    );
    const report = result as MaloRunReport;
    expect(report.ok).toBe(false);
    expect(report.failed_step).toBe(0);
    expect(report.steps[0].error?.code).toBe("E_ASSERTION_FAILED");
    expect(report.steps[0].error?.details?.checks as unknown[]).toHaveLength(2);
  });
});
