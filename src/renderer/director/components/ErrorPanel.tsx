import { Image } from "lucide-react";
import type { AppSnapshot } from "../../../shared/types";
import { pad2 } from "./format";
import { Panel } from "./Panel";
import { StatusChip } from "./StatusChip";

type Props = {
  error: AppSnapshot["error"];
  commandError: string | null;
  onOpenPath: (path: string) => void;
};

export function ErrorPanel({ error, commandError, onOpenPath }: Props) {
  const hasError = Boolean(error) || Boolean(commandError);
  const screenshotPath = error?.screenshotPath ?? null;
  return (
    <Panel
      title="错误"
      className="panel-error"
      meta={<StatusChip tone={hasError ? "danger" : "ok"} label={hasError ? "待处理" : "无错误"} />}
    >
      {error ? (
        <div className="error-block" role="alert">
          <div className="error-line">
            <code className="error-code">{error.code}</code>
            <span className="error-step mono">
              步骤 {error.stepIndex !== null ? pad2(error.stepIndex + 1) : "—"}
            </span>
          </div>
          <p className="error-message">{error.message}</p>
          {screenshotPath ? (
            <>
              <button
                type="button"
                className="text-btn"
                title={`打开截图 ${screenshotPath}`}
                onClick={() => {
                  onOpenPath(screenshotPath);
                }}
              >
                <Image size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>打开截图</span>
              </button>
              <p className="path-text" title={screenshotPath}>
                {screenshotPath}
              </p>
            </>
          ) : (
            <p className="path-text is-muted">该错误没有截图</p>
          )}
        </div>
      ) : null}
      {commandError ? (
        <div className="error-block is-command" role="alert">
          <div className="error-line">
            <code className="error-code">E_CONTROL_FAILED</code>
            <span className="error-step">控制命令</span>
          </div>
          <p className="error-message">{commandError}</p>
        </div>
      ) : null}
      {!hasError ? <p className="empty">当前没有错误记录</p> : null}
    </Panel>
  );
}
