import { useEffect, useRef } from "react";
import { Check, Circle, CircleDot, SkipForward, TriangleAlert } from "lucide-react";
import type { StepRecord, StepStatus } from "../../../shared/types";
import type { DirectorSnapshot } from "../../../preload/director-api";
import {
  formatClockTime,
  formatStepDuration,
  pad2,
  runModeText,
  runStatusText,
  runStatusTone,
  stepStatusText,
} from "./format";
import { StatusChip } from "./StatusChip";

type Props = {
  snapshot: DirectorSnapshot;
  upcoming: StepRecord | null;
};

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "passed":
      return <Check size={13} strokeWidth={2.2} aria-hidden="true" />;
    case "running":
      return <CircleDot size={13} strokeWidth={2} className="is-pulse" aria-hidden="true" />;
    case "failed":
      return <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />;
    case "skipped":
      return <SkipForward size={13} strokeWidth={2} aria-hidden="true" />;
    default:
      return <Circle size={13} strokeWidth={1.6} aria-hidden="true" />;
  }
}

export function StepPanel({ snapshot, upcoming }: Props) {
  const { run, stage } = snapshot;
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);
  const passed = run.steps.filter((step) => step.status === "passed").length;
  const percent = run.stepTotal > 0 ? Math.min(100, Math.round((passed / run.stepTotal) * 100)) : 0;
  const progressIndex = Math.min(run.stepIndex + 1, Math.max(run.stepTotal, 1));
  const stageState = stage.visible ? (stage.blackout ? "黑屏" : "可见") : "不可见";
  const blocked = run.status === "failed";

  useEffect(() => {
    rowRefs.current[run.stepIndex]?.scrollIntoView({ block: "nearest" });
  }, [run.stepIndex, stage.sceneId]);

  return (
    <section className="stage-panel" aria-label="当前场景">
      <header className="stage-head">
        <div className="scene-title-row">
          <h1 className="stage-title" title={stage.title}>
            {stage.title || "未加载场景"}
          </h1>
          <span className="scene-id mono" title={stage.sceneId ?? ""}>
            {stage.sceneId ?? "no-scene"}
          </span>
        </div>
        <div className="scene-url" title={stage.url}>
          {stage.url || "尚未加载页面"}
        </div>
        <dl className="meta-grid">
          <div>
            <dt>模式</dt>
            <dd>{runModeText(run.mode)}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd className="meta-status">
              <StatusChip tone={runStatusTone(run.status)} label={runStatusText(run.status)} pulse={run.status === "running"} />
            </dd>
          </div>
          <div>
            <dt>舞台</dt>
            <dd className={stage.blackout ? "is-blackout" : undefined}>{stageState}</dd>
          </div>
          <div>
            <dt>视口</dt>
            <dd className="mono">
              {stage.viewport.width} × {stage.viewport.height} @{stage.viewport.dpr}
            </dd>
          </div>
          <div>
            <dt>开始</dt>
            <dd className="mono">{formatClockTime(run.startedAt)}</dd>
          </div>
        </dl>
      </header>

      <div className="progress-block">
        <div className="progress-line">
          <span className="mono">
            步骤 {pad2(progressIndex)} / {pad2(run.stepTotal)}
          </span>
          <span className="mono progress-percent">{percent}%</span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={run.stepTotal}
          aria-valuenow={passed}
          aria-label="已完成步骤"
        >
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="upcoming">
        <div className="upcoming-head">
          <span className="eyebrow">{blocked ? "失败步骤待处理" : "下一步将执行"}</span>
          {upcoming ? (
            <span className="mono upcoming-ref">
              {pad2(upcoming.index + 1)} · {upcoming.action}
            </span>
          ) : (
            <span className="mono upcoming-ref">已到末尾</span>
          )}
        </div>
        <p className="upcoming-note">
          {upcoming ? (upcoming.note ?? "该步骤没有讲解备注") : "本场已执行到最后一个步骤"}
        </p>
        {upcoming ? (
          <div className="upcoming-tags">
            <span className="tag mono" title={upcoming.id}>
              {upcoming.id}
            </span>
            <span className="tag">
              {blocked
                ? "失败后已暂停"
                : upcoming.action === "wait_for_presenter"
                  ? "需要讲解人确认"
                  : "可自动执行"}
            </span>
          </div>
        ) : null}
      </div>

      <div className="steps-scroll">
        <ol className="steps-list">
          {run.steps.map((step) => {
            const active = step.index === run.stepIndex && run.status !== "done";
            return (
              <li
                key={step.index}
                ref={(node) => {
                  rowRefs.current[step.index] = node;
                }}
                className={[
                  "step-row",
                  `is-${step.status}`,
                  active ? "is-active" : "",
                  step.status === "failed" ? "is-failed" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-current={active ? "step" : undefined}
              >
                <span className={`step-status is-${step.status}`} title={stepStatusText(step.status)}>
                  <StepIcon status={step.status} />
                </span>
                <div className="step-main">
                  <div className="step-line">
                    <span
                      className="step-index mono"
                      title={step.atMs !== undefined ? `第 ${step.index + 1} 步 · ${(step.atMs / 1000).toFixed(1)}s 开始` : undefined}
                    >
                      {pad2(step.index + 1)}
                    </span>
                    <span className="step-id" title={step.id}>
                      {step.id}
                    </span>
                    <span className="step-action mono">{step.action}</span>
                    {step.durationMs !== undefined ? (
                      <span className="step-duration mono">{formatStepDuration(step.durationMs)}</span>
                    ) : null}
                  </div>
                  {step.note ? (
                    <p className="step-note" title={step.note}>
                      {step.note}
                    </p>
                  ) : null}
                  {step.status === "failed" && step.detail ? (
                    <p className="step-detail" title={step.detail}>
                      {step.detail}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {run.steps.length === 0 ? <p className="empty">当前场景没有步骤</p> : null}
      </div>
    </section>
  );
}
