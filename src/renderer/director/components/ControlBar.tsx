import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Eclipse,
  Maximize,
  Minimize,
  MonitorOff,
  OctagonAlert,
  Pause,
  Play,
  Square,
  Timer,
  Video,
} from "lucide-react";
import type { DirectorSnapshot } from "../../../preload/director-api";
import type { DisplaySummary } from "../../../shared/types";
import { DisplayMenu } from "./DisplayMenu";
import {
  formatDuration,
  isRecorderTransitional,
  pad2,
  recorderStatusText,
} from "./format";
import { IconButton } from "./IconButton";

type Props = {
  snapshot: DirectorSnapshot;
  displays: DisplaySummary[];
  hasPrevScene: boolean;
  hasNextScene: boolean;
  runElapsedMs: number;
  recorderElapsedMs: number;
  onPrevScene: () => void;
  onNextScene: () => void;
  onPrevStep: () => void;
  onNextStep: () => void;
  onTogglePlay: () => void;
  onToggleRecord: () => void;
  onToggleBlackout: () => void;
  onToggleFullscreen: () => void;
  onSelectDisplay: (displayId: number | null) => void;
  onPanic: () => void;
};

export function ControlBar({
  snapshot,
  displays,
  hasPrevScene,
  hasNextScene,
  runElapsedMs,
  recorderElapsedMs,
  onPrevScene,
  onNextScene,
  onPrevStep,
  onNextStep,
  onTogglePlay,
  onToggleRecord,
  onToggleBlackout,
  onToggleFullscreen,
  onSelectDisplay,
  onPanic,
}: Props) {
  const { run, recorder, stage } = snapshot;
  const running = run.status === "running";
  const recording = recorder.status === "recording";
  const playLabel = running ? "暂停" : run.status === "paused" ? "继续" : "开始播放";
  const playLabelWithKey = `${playLabel} (Space)`;
  const recordLabel = recording ? "停止录制" : "开始录制";
  const stepNow = Math.min(run.stepIndex + 1, Math.max(run.stepTotal, 1));
  const lastStep = run.stepIndex >= run.stepTotal || run.status === "done";

  return (
    <footer className="controlbar" role="toolbar" aria-label="演出控制">
      <div className="control-group">
        <IconButton
          icon={ChevronsLeft}
          label="上一场"
          onClick={onPrevScene}
          disabled={!hasPrevScene}
        />
        <IconButton
          icon={ChevronLeft}
          label="上一步 (←)"
          onClick={onPrevStep}
          disabled={run.stepIndex <= 0}
        />
        <IconButton
          icon={running ? Pause : Play}
          label={playLabelWithKey}
          onClick={onTogglePlay}
          tone="primary"
          size="lg"
        />
        <IconButton icon={ChevronRight} label="下一步 (→)" onClick={onNextStep} disabled={lastStep} />
        <IconButton
          icon={ChevronsRight}
          label="下一场"
          onClick={onNextScene}
          disabled={!hasNextScene}
        />
      </div>

      <div className="control-status">
        <span className="status-item mono">
          步骤 {pad2(stepNow)} / {pad2(run.stepTotal)}
        </span>
        <span className="status-sep" aria-hidden="true" />
        <span className="status-item mono" title="本次运行时长">
          <Timer size={13} strokeWidth={1.8} aria-hidden="true" />
          {formatDuration(runElapsedMs)}
        </span>
        <span className="status-sep" aria-hidden="true" />
        <span
          className={recording ? "status-item mono is-rec" : "status-item mono"}
          title={recorderStatusText(recorder.status)}
        >
          {recording ? (
            <span className="rec-dot" aria-hidden="true" />
          ) : (
            <Video size={13} strokeWidth={1.8} aria-hidden="true" />
          )}
          {formatDuration(recorderElapsedMs)} · {recorder.frames} 帧
        </span>
        <span className="status-sep" aria-hidden="true" />
        <span className="status-item kbd-hint" aria-hidden="true">
          ← → 切换步骤 · Space 播放/暂停
        </span>
      </div>

      <div className="control-group control-actions">
        <IconButton
          icon={recording ? Square : Video}
          label={recordLabel}
          onClick={onToggleRecord}
          tone={recording ? "danger" : "default"}
          disabled={isRecorderTransitional(recorder.status)}
          aria-pressed={recording}
        />
        <IconButton
          icon={stage.blackout ? Eclipse : MonitorOff}
          label={stage.blackout ? "取消黑屏" : "黑屏"}
          onClick={onToggleBlackout}
          tone={stage.blackout ? "accent" : "default"}
          aria-pressed={stage.blackout}
        />
        <span className="control-sep" aria-hidden="true" />
        <IconButton
          icon={stage.fullscreen ? Minimize : Maximize}
          label={stage.fullscreen ? "退出全屏 (⌘⌥F)" : "全屏 (⌘⌥F)"}
          onClick={onToggleFullscreen}
          tone={stage.fullscreen ? "accent" : "default"}
          aria-pressed={stage.fullscreen}
        />
        <DisplayMenu displays={displays} displayId={stage.displayId} onSelect={onSelectDisplay} />
        <span className="control-sep" aria-hidden="true" />
        <IconButton
          icon={OctagonAlert}
          label="Panic：停止录制、取消黑屏并重置场景"
          onClick={onPanic}
          tone="danger"
          className="panic-btn"
        >
          Panic
        </IconButton>
      </div>
    </footer>
  );
}
