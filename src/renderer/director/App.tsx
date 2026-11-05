import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, RotateCcw } from "lucide-react";
import type { AppEvent, ControlCommand, StepRecord } from "../../shared/types";
import type {
  DemoStagePreloadApi,
  DirectorSceneSummary,
  DirectorSnapshot,
} from "../../preload/director-api";
import { ControlBar } from "./components/ControlBar";
import { ErrorPanel } from "./components/ErrorPanel";
import { IconButton } from "./components/IconButton";
import { NotesPanel } from "./components/NotesPanel";
import { Panel } from "./components/Panel";
import { RecorderPanel } from "./components/RecorderPanel";
import { SceneList } from "./components/SceneList";
import { StepPanel } from "./components/StepPanel";
import { StatusChip } from "./components/StatusChip";
import { pad2, recorderStatusText, recorderStatusTone, runStatusText, runStatusTone } from "./components/format";

type Props = {
  api: DemoStagePreloadApi;
  mock?: boolean;
};

function updateStep(
  steps: StepRecord[],
  index: number,
  patch: (step: StepRecord) => StepRecord,
): StepRecord[] {
  if (!steps[index]) return steps;
  return steps.map((step) => (step.index === index ? patch(step) : step));
}

function applyEvent(prev: DirectorSnapshot, event: AppEvent): DirectorSnapshot {
  switch (event.type) {
    case "state.changed":
      return event.snapshot;
    case "scene.loading":
      return {
        ...prev,
        stage: { ...prev.stage, sceneId: event.sceneId },
        run: { ...prev.run, status: "loading" },
      };
    case "scene.ready":
      return {
        ...prev,
        stage: { ...prev.stage, sceneId: event.sceneId, url: event.url },
        run: { ...prev.run, status: prev.run.status === "loading" ? "ready" : prev.run.status },
      };
    case "stage.layout":
      return {
        ...prev,
        stage: {
          ...prev.stage,
          fullscreen: event.fullscreen,
          displayId: event.displayId,
          viewport: event.viewport,
        },
      };
    case "step.started": {
      const steps = updateStep(prev.run.steps, event.index, (step) => ({
        ...step,
        id: event.id,
        action: event.action,
        status: "running",
      }));
      return {
        ...prev,
        run: {
          ...prev.run,
          steps,
          stepIndex: Math.max(prev.run.stepIndex, event.index),
          status: "running",
        },
      };
    }
    case "step.completed": {
      const steps = updateStep(prev.run.steps, event.index, (step) => ({
        ...step,
        status: "passed",
        durationMs: event.durationMs,
      }));
      return {
        ...prev,
        run: {
          ...prev.run,
          steps,
          stepIndex: Math.max(prev.run.stepIndex, event.index),
        },
      };
    }
    case "step.failed": {
      const steps = updateStep(prev.run.steps, event.index, (step) => ({
        ...step,
        status: "failed",
        detail: event.message,
      }));
      return {
        ...prev,
        run: { ...prev.run, steps, stepIndex: Math.max(prev.run.stepIndex, event.index), status: "failed" },
      };
    }
    case "run.paused":
      return { ...prev, run: { ...prev.run, status: "paused", stepIndex: event.stepIndex } };
    case "run.completed":
      return {
        ...prev,
        run: {
          ...prev.run,
          status: "done",
          stepIndex: Math.max(0, event.stepTotal - 1),
          stepTotal: event.stepTotal,
        },
      };
    case "recorder.started":
      return {
        ...prev,
        recorder: { status: "recording", outputPath: event.outputPath, frames: 0, elapsedMs: 0 },
      };
    case "recorder.stopped":
      return {
        ...prev,
        recorder: {
          ...prev.recorder,
          status: "idle",
          outputPath: event.outputPath,
          frames: event.frames,
        },
      };
    case "app.error":
      return {
        ...prev,
        error: {
          code: event.code,
          message: event.message,
          // An app-level error carries no step location; reusing the previous
          // one showed a stale step number and opened an unrelated screenshot.
          stepIndex: null,
          screenshotPath: null,
        },
      };
  }
  return prev;
}

export default function App({ api, mock = false }: Props) {
  const [snapshot, setSnapshot] = useState<DirectorSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [syncAt, setSyncAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const snapshotRef = useRef<DirectorSnapshot | null>(null);

  const commit = useCallback((next: DirectorSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
    setSyncAt(Date.now());
  }, []);

  useEffect(() => {
    let alive = true;
    let ready = false;
    const buffered: AppEvent[] = [];

    const handle = (event: AppEvent) => {
      if (!ready) {
        buffered.push(event);
        return;
      }
      const prev = snapshotRef.current;
      if (!prev) return;
      commit(applyEvent(prev, event));
    };

    const unsubscribe = api.onEvent(handle);
    api
      .getSnapshot()
      .then((initial) => {
        if (!alive) return;
        let next = initial;
        for (const event of buffered) next = applyEvent(next, event);
        buffered.length = 0;
        ready = true;
        commit(next);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api, commit, reloadToken]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(tick);
  }, []);

  const drift = Math.max(0, now - syncAt);
  const runElapsedMs = (snapshot?.run.elapsedMs ?? 0) + (snapshot?.run.status === "running" ? drift : 0);
  const recorderElapsedMs =
    (snapshot?.recorder.elapsedMs ?? 0) + (snapshot?.recorder.status === "recording" ? drift : 0);

  const send = useCallback(
    (command: ControlCommand) => {
      setCommandError(null);
      api.send(command).catch((error: unknown) => {
        setCommandError(error instanceof Error ? error.message : String(error));
      });
    },
    [api],
  );

  const openPath = useCallback(
    (path: string) => {
      api.openPath(path).catch((error: unknown) => {
        setCommandError(error instanceof Error ? error.message : String(error));
      });
    },
    [api],
  );

  const scenes: DirectorSceneSummary[] = useMemo(() => {
    const listed = snapshot?.scenes ?? [];
    if (listed.length > 0) return listed;
    if (!snapshot?.stage.sceneId) return [];
    return [
      {
        id: snapshot.stage.sceneId,
        title: snapshot.stage.title,
        stepTotal: snapshot.run.stepTotal,
      },
    ];
  }, [snapshot]);

  const sceneIndex = snapshot?.stage.sceneId
    ? scenes.findIndex((scene) => scene.id === snapshot.stage.sceneId)
    : -1;

  const nextStep = useCallback(() => {
    if (!snapshotRef.current) return;
    send({ cmd: "run.next", args: {} });
  }, [send]);

  const prevStep = useCallback(() => {
    if (!snapshotRef.current) return;
    send({ cmd: "run.prev", args: {} });
  }, [send]);

  const togglePlay = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    if (current.run.status === "running") {
      send({ cmd: "run.pause", args: {} });
      return;
    }
    if (current.run.status === "paused") {
      send({ cmd: "run.resume", args: {} });
      return;
    }
    send({ cmd: "run.start", args: { mode: current.run.mode } });
  }, [send]);

  const toggleRecord = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    if (current.recorder.status === "recording") {
      send({ cmd: "recorder.stop", args: {} });
      return;
    }
    if (current.recorder.status === "starting" || current.recorder.status === "stopping") return;
    send({ cmd: "recorder.start", args: {} });
  }, [send]);

  const toggleBlackout = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    send({ cmd: "stage.blackout", args: { on: !current.stage.blackout } });
  }, [send]);

  const toggleFullscreen = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    send({ cmd: "stage.fullscreen", args: { on: !current.stage.fullscreen } });
  }, [send]);

  const selectDisplay = useCallback(
    (displayId: number | null) => {
      send({ cmd: "stage.display", args: { displayId } });
    },
    [send],
  );

  const panic = useCallback(() => {
    const current = snapshotRef.current;
    if (!current) return;
    if (current.recorder.status === "recording") send({ cmd: "recorder.stop", args: {} });
    if (current.stage.blackout) send({ cmd: "stage.blackout", args: { on: false } });
    send({ cmd: "run.reset", args: { policy: "reload" } });
  }, [send]);

  const actionsRef = useRef({ nextStep, prevStep, togglePlay });
  actionsRef.current = { nextStep, prevStep, togglePlay };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (target.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        // Open menus own their arrow keys; space on a control must activate it.
        if (target.closest('[role="menu"],[role="listbox"]')) return;
        if ((event.key === " " || event.code === "Space") && target.closest('button,[role="button"]')) return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        actionsRef.current.nextStep();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        actionsRef.current.prevStep();
      } else if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        actionsRef.current.togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!snapshot) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <p className="boot-title">Director 尚未连接主进程</p>
          {loadError ? <p className="boot-msg">{loadError}</p> : <p className="boot-msg is-muted">正在读取运行快照…</p>}
          <IconButton
            icon={RotateCcw}
            label="重新读取快照"
            onClick={() => {
              setLoadError(null);
              setReloadToken((token) => token + 1);
            }}
          >
            重试
          </IconButton>
        </div>
      </div>
    );
  }

  // `stepIndex` means "last executed step" (-1 before the first). The step that
  // runs next is always the following one, whatever the run status is.
  const currentStep = snapshot.run.steps[snapshot.run.stepIndex] ?? null;
  const upcomingIndex = snapshot.run.stepIndex + 1;
  const upcoming =
    snapshot.run.status !== "done" && upcomingIndex < snapshot.run.stepTotal
      ? (snapshot.run.steps[upcomingIndex] ?? null)
      : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-mark" aria-hidden="true">
            <Clapperboard size={15} strokeWidth={1.9} />
          </span>
          <span className="brand-name">Malo Browser</span>
          <span className="brand-role">Director</span>
          {mock ? (
            <span title="未连接主进程，当前展示 mock 数据">
              <StatusChip tone="warn" label="MOCK" />
            </span>
          ) : null}
        </div>
        <div className="topbar-meta">
          <span className="topbar-item mono">v{snapshot.app.version}</span>
          <span className="topbar-item topbar-slow">Electron {snapshot.app.electron}</span>
          <span className="topbar-item topbar-slow">Chromium {snapshot.app.chromium}</span>
          <span className="topbar-item mono">
            {snapshot.stage.viewport.width} × {snapshot.stage.viewport.height} @{snapshot.stage.viewport.dpr}
          </span>
        </div>
        <div className="topbar-status">
          <StatusChip
            tone={runStatusTone(snapshot.run.status)}
            label={runStatusText(snapshot.run.status)}
            pulse={snapshot.run.status === "running"}
            announce
          />
          <StatusChip
            tone={recorderStatusTone(snapshot.recorder.status)}
            label={recorderStatusText(snapshot.recorder.status)}
            pulse={snapshot.recorder.status === "recording"}
            announce
          />
        </div>
      </header>

      <main className="workspace">
        <div className="col col-scenes">
          <Panel
            title="场景"
            className="panel-scenes"
            meta={
              <span className="mono panel-count">
                {pad2(scenes.length)}
              </span>
            }
          >
            <SceneList
              scenes={scenes}
              currentId={snapshot.stage.sceneId}
              onSelect={(sceneId) => send({ cmd: "scene.load", args: { sceneId } })}
            />
          </Panel>
        </div>

        <div className="col col-stage">
          <StepPanel snapshot={snapshot} upcoming={upcoming} />
        </div>

        <div className="col col-notes">
          <Panel
            title="讲解备注"
            className="panel-notes"
            meta={
              currentStep ? (
                <span className="mono panel-count">#{pad2(currentStep.index + 1)}</span>
              ) : null
            }
          >
            <NotesPanel currentStep={currentStep} upcoming={upcoming} />
          </Panel>
          <ErrorPanel error={snapshot.error} commandError={commandError} onOpenPath={openPath} />
          <RecorderPanel
            recorder={snapshot.recorder}
            elapsedMs={recorderElapsedMs}
            onOpenPath={openPath}
          />
        </div>
      </main>

      <ControlBar
        snapshot={snapshot}
        displays={snapshot.displays ?? []}
        hasPrevScene={sceneIndex > 0}
        hasNextScene={sceneIndex >= 0 && sceneIndex < scenes.length - 1}
        runElapsedMs={runElapsedMs}
        recorderElapsedMs={recorderElapsedMs}
        onPrevScene={() => {
          if (sceneIndex > 0) send({ cmd: "scene.load", args: { sceneId: scenes[sceneIndex - 1].id } });
        }}
        onNextScene={() => {
          if (sceneIndex >= 0 && sceneIndex < scenes.length - 1) {
            send({ cmd: "scene.load", args: { sceneId: scenes[sceneIndex + 1].id } });
          }
        }}
        onPrevStep={prevStep}
        onNextStep={nextStep}
        onTogglePlay={togglePlay}
        onToggleRecord={toggleRecord}
        onToggleBlackout={toggleBlackout}
        onToggleFullscreen={toggleFullscreen}
        onSelectDisplay={selectDisplay}
        onPanic={panic}
      />
    </div>
  );
}
