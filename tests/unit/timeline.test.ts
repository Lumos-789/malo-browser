import { describe, expect, it } from "vitest";
import { DemoError, isDemoError } from "../../src/shared/errors";
import { buildTimeline } from "../../src/main/capture/timeline";

describe("buildTimeline", () => {
  it("把单帧铺满整段录制", () => {
    const slots = buildTimeline([{ tMs: 1000 }], 1000, 2000, 30);
    expect(slots).toHaveLength(30);
    expect(slots).toEqual(new Array(30).fill(0));
  });

  it("稀疏帧沿用上一帧直到下一帧到达", () => {
    const slots = buildTimeline([{ tMs: 0 }, { tMs: 1000 }], 0, 2000, 30);
    expect(slots).toHaveLength(60);
    expect(slots.slice(0, 30)).toEqual(new Array(30).fill(0));
    expect(slots.slice(30)).toEqual(new Array(30).fill(1));
  });

  it("乱序到达的帧按时间排序，仍返回原数组下标", () => {
    const slots = buildTimeline([{ tMs: 1000 }, { tMs: 0 }], 0, 2000, 30);
    expect(slots).toHaveLength(60);
    expect(slots.slice(0, 30)).toEqual(new Array(30).fill(1));
    expect(slots.slice(30)).toEqual(new Array(30).fill(0));
  });

  it("区间外的帧裁剪到首尾槽位", () => {
    const slots = buildTimeline([{ tMs: -500 }, { tMs: 2500 }], 0, 2000, 30);
    expect(slots).toHaveLength(60);
    expect(slots[0]).toBe(0);
    expect(slots.slice(0, 59)).toEqual(new Array(59).fill(0));
    expect(slots[59]).toBe(1);
  });

  it("零帧抛 E_RECORDER_NO_FRAMES", () => {
    let caught: unknown;
    try {
      buildTimeline([], 0, 1000, 30);
    } catch (error) {
      caught = error;
    }
    expect(isDemoError(caught)).toBe(true);
    expect((caught as DemoError).code).toBe("E_RECORDER_NO_FRAMES");
  });
});
