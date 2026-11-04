import type { RecorderState, RunMode, RunStatus, StepStatus } from "../../../shared/types";
import type { Tone } from "./StatusChip";

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(seconds)}`;
  return `${pad2(minutes)}:${pad2(seconds)}`;
}

export function formatStepDuration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

export function formatClockTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function runModeText(mode: RunMode): string {
  switch (mode) {
    case "rehearse":
      return "排练";
    case "live":
      return "现场 Live";
    case "record":
      return "录制";
    case "headless":
      return "无头";
  }
}

export function runStatusText(status: RunStatus): string {
  switch (status) {
    case "idle":
      return "未开始";
    case "loading":
      return "加载中";
    case "ready":
      return "待开始";
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
    case "failed":
      return "失败";
    case "done":
      return "已完成";
  }
}

export function runStatusTone(status: RunStatus): Tone {
  switch (status) {
    case "running":
      return "ok";
    case "paused":
      return "warn";
    case "failed":
      return "danger";
    case "done":
      return "info";
    default:
      return "idle";
  }
}

export function recorderStatusText(status: RecorderState): string {
  switch (status) {
    case "idle":
      return "未录制";
    case "starting":
      return "启动中";
    case "recording":
      return "录制中";
    case "stopping":
      return "停止中";
    case "failed":
      return "录制失败";
  }
}

export function recorderStatusTone(status: RecorderState): Tone {
  switch (status) {
    case "recording":
      return "rec";
    case "starting":
    case "stopping":
      return "warn";
    case "failed":
      return "danger";
    default:
      return "idle";
  }
}

export function stepStatusText(status: StepStatus): string {
  switch (status) {
    case "pending":
      return "待执行";
    case "running":
      return "执行中";
    case "passed":
      return "已完成";
    case "failed":
      return "失败";
    case "skipped":
      return "已跳过";
  }
}

export function isRecorderTransitional(status: RecorderState): boolean {
  return status === "starting" || status === "stopping";
}
