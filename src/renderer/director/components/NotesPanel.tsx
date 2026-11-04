import type { StepRecord } from "../../../shared/types";
import { pad2 } from "./format";

type Props = {
  currentStep: StepRecord | null;
  upcoming: StepRecord | null;
};

export function NotesPanel({ currentStep, upcoming }: Props) {
  return (
    <>
      <div className="note-block">
        <div className="note-label">当前步骤</div>
        <p className={currentStep?.note ? "note-text" : "note-text is-muted"}>
          {currentStep?.note ?? "当前步骤没有讲解备注"}
        </p>
        {currentStep ? (
          <div className="note-tags">
            <span className="tag mono">
              #{pad2(currentStep.index + 1)} {currentStep.id}
            </span>
            <span className="tag mono">{currentStep.action}</span>
          </div>
        ) : null}
      </div>
      <div className="note-block">
        <div className="note-label">下一步</div>
        <p className={upcoming?.note ? "note-text" : "note-text is-muted"}>
          {upcoming ? (upcoming.note ?? "该步骤没有讲解备注") : "本场已到最后一个步骤"}
        </p>
        {upcoming ? (
          <div className="note-tags">
            <span className="tag mono">
              #{pad2(upcoming.index + 1)} {upcoming.id}
            </span>
            <span className="tag">
              {upcoming.action === "wait_for_presenter" ? "需要讲解人确认" : "自动执行"}
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
}
