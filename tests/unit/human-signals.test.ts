import { describe, expect, it } from "vitest";
import {
  applyHumanSignal,
  consumeHumanDone,
  humanBlock,
  initialHumanState,
} from "../../src/main/malo/human-signals";

const step = (state: ReturnType<typeof initialHumanState>, ...signals: Parameters<typeof applyHumanSignal>[1][]) =>
  signals.reduce((current, signal) => applyHumanSignal(current, signal).state, state);

describe("human signals", () => {
  it("records each signal once and ignores repeats", () => {
    let current = initialHumanState();

    const done = applyHumanSignal(current, "done");
    expect(done.event).toBe("human.done");
    expect(applyHumanSignal(done.state, "done")).toEqual({ state: done.state, event: null });

    const paused = applyHumanSignal(done.state, "pause");
    expect(paused.event).toBe("human.paused");
    expect(applyHumanSignal(paused.state, "pause").event).toBeNull();
    const resumed = applyHumanSignal(paused.state, "resume");
    expect(resumed.event).toBe("human.resumed");
    expect(applyHumanSignal(resumed.state, "resume").event).toBeNull();
  });

  it("treats stop as final: nothing is accepted afterwards", () => {
    const stopped = applyHumanSignal(step(initialHumanState(), "pause"), "stop");

    expect(stopped.state).toEqual({ done: false, paused: false, stopped: true });
    expect(stopped.event).toBe("human.stopped");
    for (const signal of ["done", "pause", "resume", "stop"] as const) {
      expect(applyHumanSignal(stopped.state, signal)).toEqual({ state: stopped.state, event: null });
    }
  });

  it("hands out the done signal exactly once so the next handoff can use it again", () => {
    const waiting = step(initialHumanState(), "done");

    expect(consumeHumanDone(waiting)).toEqual({ done: true, state: initialHumanState() });
    expect(consumeHumanDone(initialHumanState()).done).toBe(false);
  });

  it("blocks the agent while paused or stopped and lets it work otherwise", () => {
    expect(humanBlock(initialHumanState())).toBeNull();
    expect(humanBlock(step(initialHumanState(), "done"))).toBeNull();
    expect(humanBlock(step(initialHumanState(), "pause"))).toBe("E_PAUSED_BY_HUMAN");
    expect(humanBlock(step(initialHumanState(), "pause", "resume"))).toBeNull();
    expect(humanBlock(step(initialHumanState(), "stop"))).toBe("E_STOPPED_BY_HUMAN");
  });
});
