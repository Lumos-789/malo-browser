import { DemoError } from "../../shared/errors";

export type TimelineFrame = { tMs: number };

/**
 * 把到达时间映射到固定 fps 槽位，返回值为传入 frames 数组的下标。
 */
export function buildTimeline(
  frames: TimelineFrame[],
  startMs: number,
  endMs: number,
  fps: number,
): number[] {
  if (frames.length === 0) {
    throw new DemoError("E_RECORDER_NO_FRAMES", "没有采到任何画面帧");
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `录制区间无效：startMs=${startMs}，endMs=${endMs}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new DemoError("E_EVIDENCE_MISMATCH", `帧率无效：${fps}`);
  }

  const ordered = frames
    .map((frame, index) => ({ index, tMs: frame.tMs }))
    .sort((a, b) => a.tMs - b.tMs || a.index - b.index);

  for (const frame of ordered) {
    if (!Number.isFinite(frame.tMs)) {
      throw new DemoError("E_EVIDENCE_MISMATCH", `帧时间戳无效：${frame.tMs}`);
    }
  }

  const total = Math.max(1, Math.round(((endMs - startMs) / 1000) * fps));
  const slots = new Array<number>(total).fill(-1);
  for (const frame of ordered) {
    const position = Math.round(((frame.tMs - startMs) / 1000) * fps);
    slots[Math.min(total - 1, Math.max(0, position))] = frame.index;
  }

  let current = slots.find((index) => index >= 0);
  if (current === undefined) {
    throw new DemoError("E_RECORDER_NO_FRAMES", "时间轴没有可用帧");
  }
  for (let slot = 0; slot < total; slot += 1) {
    if (slots[slot] < 0) slots[slot] = current;
    else current = slots[slot];
  }
  return slots;
}
