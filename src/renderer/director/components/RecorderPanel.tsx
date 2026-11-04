import { FolderOpen } from "lucide-react";
import type { AppSnapshot } from "../../../shared/types";
import { formatDuration, recorderStatusText, recorderStatusTone } from "./format";
import { IconButton } from "./IconButton";
import { Panel } from "./Panel";
import { StatusChip } from "./StatusChip";

type Props = {
  recorder: AppSnapshot["recorder"];
  elapsedMs: number;
  onOpenPath: (path: string) => void;
};

export function RecorderPanel({ recorder, elapsedMs, onOpenPath }: Props) {
  const outputPath = recorder.outputPath;
  return (
    <Panel
      title="录制"
      className="panel-recorder"
      meta={
        <StatusChip
          tone={recorderStatusTone(recorder.status)}
          label={recorderStatusText(recorder.status)}
          pulse={recorder.status === "recording"}
        />
      }
    >
      <dl className="kv-grid">
        <div>
          <dt>时长</dt>
          <dd className="mono">{formatDuration(elapsedMs)}</dd>
        </div>
        <div>
          <dt>帧数</dt>
          <dd className="mono">{recorder.frames.toString()}</dd>
        </div>
      </dl>
      <div className="path-row">
        <span className="path-label">输出</span>
        <span className="path-text" title={outputPath ?? ""}>
          {outputPath ?? "尚未生成"}
        </span>
        {outputPath ? (
          <IconButton
            icon={FolderOpen}
            label="打开录制文件"
            onClick={() => {
              onOpenPath(outputPath);
            }}
          />
        ) : null}
      </div>
    </Panel>
  );
}
