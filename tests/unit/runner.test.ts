import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DemoError } from "../../src/shared/errors";
import type { Scene, SceneStep } from "../../src/shared/scene";
import type { AppEvent, Point, Rect } from "../../src/shared/types";
import type { ClickOptions, PageDriver, WaitState } from "../../src/main/core/page-driver";
import type {
  AnnotateOptions,
  MaskOptions,
  OverlayPort,
  SpotlightOptions,
} from "../../src/main/core/ports";
import { Runner, type RunnerEvent } from "../../src/main/runner";

const SHOT_DIR = "/tmp/demo-runner-shots";

class FakeDriver implements PageDriver {
  readonly navigations: string[] = [];
  readonly moves: Point[] = [];
  readonly clicks: Array<{ point: Point; options?: ClickOptions }> = [];
  readonly inserted: string[] = [];
  readonly pressed: Array<{ key: string; modifiers?: number }> = [];
  readonly scrolls: Point[] = [];
  readonly screenshots: string[] = [];
  readonly selectorWaits: Array<{ selector: string; state: WaitState; timeoutMs: number }> = [];
  readonly evaluations: string[] = [];
  readonly rects = new Map<string, Rect>();
  selectAllCalls = 0;
  clickGate: Promise<void> | null = null;
  waitForSelectorImpl: ((selector: string, state: WaitState, timeoutMs: number) => Promise<void>) | null =
    null;
  evaluateImpl: ((expression: string) => unknown) | null = null;
  currentUrl = "http://demo.test/current";

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
  }

  async waitForSelector(selector: string, state: WaitState, timeoutMs: number): Promise<void> {
    this.selectorWaits.push({ selector, state, timeoutMs });
    if (this.waitForSelectorImpl) return this.waitForSelectorImpl(selector, state, timeoutMs);
    if (selector === "body") return;
    throw new Error(`E_SELECTOR_NOT_FOUND: ${selector}`);
  }

  async waitForText(): Promise<void> {
    return;
  }

  async waitForUrl(): Promise<void> {
    return;
  }

  async evaluate<T>(expression: string): Promise<T> {
    this.evaluations.push(expression);
    return (this.evaluateImpl ? this.evaluateImpl(expression) : true) as T;
  }

  async rect(selector: string): Promise<Rect> {
    const rect = this.rects.get(selector);
    if (!rect) throw new Error(`E_SELECTOR_NOT_FOUND: ${selector}`);
    return rect;
  }

  async url(): Promise<string> {
    return this.currentUrl;
  }

  async move(point: Point): Promise<void> {
    this.moves.push(point);
  }

  async click(point: Point, options?: ClickOptions): Promise<void> {
    if (this.clickGate) await this.clickGate;
    this.clicks.push({ point, options });
  }

  async insertText(text: string): Promise<void> {
    this.inserted.push(text);
  }

  async press(key: string, modifiers?: number): Promise<void> {
    this.pressed.push({ key, modifiers });
  }

  async selectAll(): Promise<void> {
    this.selectAllCalls += 1;
  }

  async scroll(delta: Point): Promise<void> {
    this.scrolls.push(delta);
  }

  async screenshot(target: string): Promise<void> {
    this.screenshots.push(target);
  }
}

class FakeOverlay implements OverlayPort {
  readonly moves: Point[] = [];
  readonly clicks: Point[] = [];
  readonly highlights: Array<{ rect: Rect; seconds: number; color?: string }> = [];
  readonly spotlights: Array<{ rect: Rect; options?: SpotlightOptions }> = [];
  readonly annotations: Array<{ rect: Rect; options: AnnotateOptions }> = [];
  readonly masks: Array<{ rect: Rect; options?: MaskOptions }> = [];
  readonly blackouts: boolean[] = [];
  clears = 0;
  failHighlight = false;

  async move(point: Point): Promise<void> {
    this.moves.push(point);
  }

  async click(point: Point): Promise<void> {
    this.clicks.push(point);
  }

  async highlight(rect: Rect, seconds: number, color?: string): Promise<void> {
    if (this.failHighlight) throw new Error("overlay highlight failed");
    this.highlights.push({ rect, seconds, color });
  }

  async spotlight(rect: Rect, options?: SpotlightOptions): Promise<void> {
    this.spotlights.push({ rect, options });
  }

  async annotate(rect: Rect, options: AnnotateOptions): Promise<void> {
    this.annotations.push({ rect, options });
  }

  async mask(rect: Rect, options?: MaskOptions): Promise<void> {
    this.masks.push({ rect, options });
  }

  async blackout(on: boolean): Promise<void> {
    this.blackouts.push(on);
  }

  async clear(): Promise<void> {
    this.clears += 1;
  }
}

function makeScene(steps: SceneStep[], overrides: Partial<Scene> = {}): Scene {
  return {
    schemaVersion: 1,
    id: "test-scene",
    title: "Test Scene",
    url: "http://demo.test/app",
    viewport: { width: 1440, height: 900 },
    profile: "demo",
    allow: ["http://demo.test"],
    permissions: [],
    resetPolicy: "reload",
    vars: { user: "demo@example.test" },
    steps,
    rootDir: "/tmp/test-scene",
    ...overrides,
  };
}

function makeRunner(driver: FakeDriver, overlay: FakeOverlay, onEvent?: (event: RunnerEvent) => void) {
  return new Runner({
    driver,
    overlay,
    screenshotDir: SHOT_DIR,
    onEvent,
  });
}

function rect(x: number, y: number, width = 40, height = 30): Rect {
  return { x, y, left: x - width / 2, top: y - height / 2, width, height };
}

describe("Runner", () => {
  it("clicks through physical driver events at the resolved data_demo_id coordinates", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set('[data-demo-id="cta"]', rect(120, 80));
    driver.rects.set("#fallback", rect(1, 2));
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([
        {
          id: "go",
          action: "click",
          data_demo_id: "cta",
          selector: "#fallback",
        },
      ]),
    );
    const snapshot = await runner.start("record");

    expect(snapshot.status).toBe("done");
    expect(driver.clicks).toEqual([
      { point: { x: 120, y: 80 }, options: { button: "left", clickCount: 1 } },
    ]);
    expect(driver.moves).toContainEqual({ x: 120, y: 80 });
    expect(overlay.clicks).toEqual([{ x: 120, y: 80 }]);
    expect(driver.evaluations.some((expression) => /\.click\s*\(/.test(expression))).toBe(false);
  });

  it("fills through physical click, select-all, backspace and insertText", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#search", rect(60, 40));
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([
        {
          id: "search",
          action: "fill",
          selector: "#search",
          text: "risk",
        },
      ]),
    );
    await runner.start("record");

    expect(driver.clicks).toHaveLength(1);
    expect(driver.clicks[0].point).toEqual({ x: 60, y: 40 });
    expect(driver.selectAllCalls).toBe(1);
    expect(driver.pressed).toEqual([{ key: "Backspace", modifiers: undefined }]);
    expect(driver.inserted).toEqual(["risk"]);
  });

  it("takes step-<i>.png before failing an assertion", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    const runner = makeRunner(driver, overlay);
    const screenshotPath = path.join(SHOT_DIR, "step-0.png");

    await runner.load(
      makeScene([
        {
          id: "verify",
          action: "assert",
          visible: "#missing",
        },
      ]),
    );

    await expect(runner.start("record")).rejects.toMatchObject({ code: "E_ASSERTION_FAILED" });
    const snapshot = runner.snapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error?.screenshotPath).toBe(screenshotPath);
    expect(driver.screenshots).toContain(screenshotPath);
    expect(snapshot.steps[0].status).toBe("failed");
  });

  it("surfaces E_STEP_TIMEOUT when an action never settles", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.waitForSelectorImpl = (selector) =>
      selector === "body" ? Promise.resolve() : new Promise<void>(() => undefined);
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([
        {
          id: "slow",
          action: "wait_for",
          selector: "#slow",
          timeout_ms: 25,
        },
      ]),
    );

    await expect(runner.start("record")).rejects.toMatchObject({ code: "E_STEP_TIMEOUT" });
    expect(runner.snapshot().status).toBe("failed");
    expect(runner.snapshot().steps[0].status).toBe("failed");
  });

  it("honours pause() after the current step and resumes with next()", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#cta", rect(10, 10));
    let release: () => void = () => undefined;
    driver.clickGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([
        { id: "click", action: "click", selector: "#cta" },
        { id: "note", action: "note", text: "done" },
      ]),
    );
    const starting = runner.start("record");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pauseSnapshot = runner.pause();
    expect(pauseSnapshot.status).toBe("running");
    release();
    await starting;

    let snapshot = runner.snapshot();
    expect(snapshot.status).toBe("paused");
    expect(snapshot.steps[0].status).toBe("passed");
    expect(snapshot.steps[1].status).toBe("pending");

    await runner.next();
    snapshot = runner.snapshot();
    expect(snapshot.status).toBe("done");
    expect(snapshot.steps[1].status).toBe("passed");
  });

  it("stops after a manual step in live mode and advances on next()", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    const events: RunnerEvent[] = [];
    const runner = makeRunner(driver, overlay, (event) => events.push(event));

    await runner.load(
      makeScene([
        { id: "one", action: "note", text: "first" },
        { id: "two", action: "note", text: "second" },
      ]),
    );

    let snapshot = await runner.start("live");
    expect(snapshot.status).toBe("paused");
    expect(snapshot.stepIndex).toBe(0);

    snapshot = await runner.next();
    expect(snapshot.status).toBe("paused");
    expect(snapshot.stepIndex).toBe(1);

    snapshot = await runner.next();
    expect(snapshot.status).toBe("done");
    expect(events.filter((event) => event.type === "run.paused")).toHaveLength(2);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
  });

  it("treats advance: manual as a pause even outside live mode", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    const runner = makeRunner(driver, overlay);

    await runner.load(makeScene([{ id: "hold", action: "note", text: "hold", advance: "manual" }]));
    const snapshot = await runner.start("record");

    expect(snapshot.status).toBe("paused");
    expect(snapshot.steps[0].status).toBe("passed");
  });

  it("reloads and resets records when prev() cannot restore page state", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#cta", rect(20, 20));
    const events: RunnerEvent[] = [];
    const runner = makeRunner(driver, overlay, (event) => events.push(event));

    await runner.load(
      makeScene([
        { id: "click", action: "click", selector: "#cta" },
        { id: "note", action: "note", text: "after" },
      ]),
    );
    await runner.start("live");
    expect(driver.navigations).toHaveLength(1);

    const snapshot = await runner.prev();

    expect(driver.navigations).toHaveLength(2);
    expect(snapshot.status).toBe("paused");
    expect(snapshot.stepIndex).toBe(0);
    expect(snapshot.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
    const paused = events
      .filter((event): event is Extract<RunnerEvent, { type: "run.paused" }> => event.type === "run.paused")
      .at(-1);
    expect(paused).toMatchObject({ stepIndex: 0, reloaded: true });
  });

  it("lets on_error: warn visual failures through and records a warning", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#box", rect(30, 30, 100, 50));
    overlay.failHighlight = true;
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([
        {
          id: "glow",
          action: "highlight",
          selector: "#box",
          onError: "warn",
        },
        { id: "after", action: "note", text: "still running" },
      ]),
    );
    const snapshot = await runner.start("record");

    expect(snapshot.status).toBe("done");
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.steps[0].status).toBe("failed");
    expect(snapshot.steps[1].status).toBe("passed");
  });

  it("passes highlight duration to the overlay in seconds", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#box", rect(30, 30, 100, 50));
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([{ id: "glow", action: "highlight", selector: "#box", seconds: 2.5, color: "#f00" }]),
    );
    await runner.start("record");

    expect(overlay.highlights).toHaveLength(1);
    expect(overlay.highlights[0].seconds).toBe(2.5);
    expect(overlay.highlights[0].color).toBe("#f00");
  });

  it("skips a failed optional visual step but rejects optional on non-visual steps", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#box", rect(30, 30, 100, 50));
    overlay.failHighlight = true;
    const runner = makeRunner(driver, overlay);

    await runner.load(
      makeScene([{ id: "glow", action: "highlight", selector: "#box", optional: true }]),
    );
    const snapshot = await runner.start("record");
    expect(snapshot.status).toBe("done");
    expect(snapshot.steps[0].status).toBe("skipped");

    await expect(
      runner.load(makeScene([{ id: "bad", action: "click", selector: "#box", optional: true }])),
    ).rejects.toMatchObject({ code: "E_SCENE_INVALID" });
  });

  it("rejects on_error: warn on non-visual actions at load time", async () => {
    const runner = makeRunner(new FakeDriver(), new FakeOverlay());
    await expect(
      runner.load(
        makeScene([{ id: "bad", action: "note", text: "x", onError: "warn" }]),
      ),
    ).rejects.toMatchObject({ code: "E_SCENE_INVALID" });
  });

  it("emits step and app error events when a step fails", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.waitForSelectorImpl = (selector) =>
      selector === "body" ? Promise.resolve() : Promise.reject(new Error("E_SELECTOR_NOT_FOUND"));
    const events: AppEvent[] = [];
    const runner = makeRunner(driver, overlay, (event) => events.push(event as AppEvent));

    await runner.load(
      makeScene([{ id: "bad", action: "click", selector: "#missing" }]),
    );
    await expect(runner.start("record")).rejects.toBeTruthy();

    expect(events.some((event) => event.type === "step.failed")).toBe(true);
    expect(events.some((event) => event.type === "app.error")).toBe(true);
  });

  it("keeps one error-code prefix when a step fails", async () => {
    const driver = new FakeDriver();
    driver.waitForSelectorImpl = (selector) =>
      selector === "body" ? Promise.resolve() : Promise.reject(new Error("E_SELECTOR_NOT_FOUND: #missing"));
    const events: AppEvent[] = [];
    const runner = makeRunner(driver, new FakeOverlay(), (event) => events.push(event as AppEvent));
    await runner.load(makeScene([{ id: "bad", action: "click", selector: "#missing" }]));

    const error = await runner.start("record").then(
      () => null,
      (thrown: DemoError) => thrown,
    );

    const expected = "E_SELECTOR_NOT_FOUND: 找不到元素 #missing";
    expect(error?.message).toBe(expected);
    expect(runner.snapshot().steps[0].detail).toBe(expected);
    const failure = events.find((event) => event.type === "step.failed");
    expect(failure && "message" in failure ? failure.message : null).toBe(expected);
  });

  it("reset returns the scene to a clean ready state", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    const runner = makeRunner(driver, overlay);
    await runner.load(makeScene([{ id: "one", action: "note", text: "first" }]));
    await runner.start("record");
    expect(runner.snapshot().status).toBe("done");

    const snapshot = await runner.reset();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.steps[0].status).toBe("pending");
    expect(overlay.clears).toBeGreaterThanOrEqual(1);
  });

  it("stops a running loop without auto-retrying the current step", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    driver.rects.set("#cta", rect(5, 5));
    let release: () => void = () => undefined;
    driver.clickGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = makeRunner(driver, overlay);
    await runner.load(
      makeScene([
        { id: "click", action: "click", selector: "#cta" },
        { id: "after", action: "note", text: "never" },
      ]),
    );
    const starting = runner.start("record");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runner.stop();
    release();
    await starting;

    const snapshot = runner.snapshot();
    expect(snapshot.status).toBe("ready");
    expect(driver.clicks).toHaveLength(1);
    expect(snapshot.steps[1].status).toBe("pending");
  });

  it("does not touch driver.screenshot for non-assertion failures", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    const runner = makeRunner(driver, overlay);
    const screenshotSpy = vi.spyOn(driver, "screenshot");

    await runner.load(makeScene([{ id: "bad", action: "click", selector: "#missing" }]));
    await expect(runner.start("record")).rejects.toBeTruthy();
    expect(screenshotSpy).not.toHaveBeenCalled();
  });

  it("installs the target scene before navigating so policy can switch first", async () => {
    const driver = new FakeDriver();
    const overlay = new FakeOverlay();
    const order: string[] = [];
    const originalNavigate = driver.navigate.bind(driver);
    driver.navigate = async (url: string) => {
      order.push(`navigate:${url}`);
      return originalNavigate(url);
    };
    const nextScene = makeScene([{ id: "note", action: "note", text: "next" }], {
      id: "next-scene",
      url: "http://next.test/app",
      allow: ["http://next.test"],
    });
    const runner = new Runner({
      driver,
      overlay,
      screenshotDir: SHOT_DIR,
      resolveScene: async () => nextScene,
      onSceneWillInstall: (scene) => order.push(`install:${scene.id}`),
    });

    await runner.load(makeScene([{ id: "switch", action: "scene", scene_id: "next-scene" }]));
    const snapshot = await runner.start("record");

    expect(snapshot.status).toBe("paused");
    const install = order.indexOf("install:next-scene");
    const navigate = order.findIndex((entry) => entry.startsWith("navigate:http://next.test"));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(navigate).toBeGreaterThan(install);
    expect(runner.currentScene()?.id).toBe("next-scene");
  });
});
