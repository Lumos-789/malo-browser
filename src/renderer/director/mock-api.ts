import type { AppEvent, DisplaySummary, StepRecord } from "../../shared/types";
import type {
  DemoStagePreloadApi,
  DirectorSceneSummary,
  DirectorSnapshot,
} from "../../preload/director-api";

type MockStep = {
  id: string;
  action: string;
  note: string;
};

type MockScene = {
  id: string;
  title: string;
  description: string;
  profile: string;
  url: string;
  steps: MockStep[];
};

const MOCK_SCENES: MockScene[] = [
  {
    id: "opening",
    title: "开场 · 登录",
    description: "演示账号登录与首页导览",
    profile: "demo-live",
    url: "http://127.0.0.1:4788/login.html",
    steps: [
      { id: "open-login", action: "goto", note: "打开演示环境登录页，先让观众看清地址是 127.0.0.1 演示环境。" },
      { id: "focus-account", action: "highlight", note: "高亮账号输入框，说明这里只使用演示账号。" },
      { id: "submit-login", action: "click", note: "点击登录，等跳转到工作台首页再继续。" },
      { id: "wait-workspace", action: "wait_for", note: "等工作台骨架加载完成，出现订单队列面板。" },
    ],
  },
  {
    id: "report",
    title: "报表 · 风控复核",
    description: "订单队列筛选与风险订单复核",
    profile: "demo-live",
    url: "http://127.0.0.1:4788/index.html?scene=report",
    steps: [
      { id: "wait-ready", action: "wait_for", note: "页面右上角出现演示账号，说明 fixture 已就绪。" },
      { id: "mark-reviewed", action: "click", note: "点击「标记已复核」，计数器从 0 变成 1。" },
      { id: "search-risk", action: "fill", note: "在搜索框输入「风险」，只留下风险订单。" },
      { id: "assert-filter", action: "assert", note: "确认列表只剩 SO-2026-1043，其他订单被过滤。" },
      { id: "highlight-row", action: "highlight", note: "高亮金额异常那一行，停顿两秒再收尾。" },
    ],
  },
  {
    id: "permission",
    title: "权限 · 角色切换",
    description: "管理员与只读角色的操作边界",
    profile: "demo-admin",
    url: "http://127.0.0.1:4788/permissions.html",
    steps: [
      { id: "open-members", action: "click", note: "打开成员管理，展示当前管理员角色。" },
      { id: "switch-reader", action: "click", note: "把角色切换到只读，页面按钮立即变灰。" },
      { id: "verify-deny", action: "assert", note: "断言编辑按钮不可用，且没有请求发出。" },
    ],
  },
];

const MOCK_DISPLAYS: DisplaySummary[] = [
  {
    id: 724858112,
    label: "内置 Retina 显示器",
    width: 3024,
    height: 1964,
    scaleFactor: 2,
    primary: true,
  },
  {
    id: 724858999,
    label: "Studio Display",
    width: 5120,
    height: 2880,
    scaleFactor: 2,
    primary: false,
  },
];

const WINDOWED_VIEWPORT = { width: 1440, height: 900, dpr: 2 };

const FAILING_STEP = { sceneId: "report", stepId: "highlight-row" };
const ACTIVE_STEP_MS = 450;

function summarize(scene: MockScene): DirectorSceneSummary {
  return {
    id: scene.id,
    title: scene.title,
    description: scene.description,
    profile: scene.profile,
    stepTotal: scene.steps.length,
  };
}

function buildSteps(scene: MockScene, passed = 0): StepRecord[] {
  return scene.steps.map((step, index) => ({
    index,
    id: step.id,
    action: step.action,
    note: step.note,
    status: index < passed ? "passed" : "pending",
    atMs: index < passed ? 1200 + index * 2400 : undefined,
    durationMs: index < passed ? 900 + index * 120 : undefined,
  }));
}

export function createMockApi(): DemoStagePreloadApi {
  const listeners = new Set<(event: AppEvent) => void>();
  const initialScene = MOCK_SCENES[1];

  const displayFor = (displayId: number | null): DisplaySummary => {
    if (displayId === null) return MOCK_DISPLAYS.find((display) => display.primary) ?? MOCK_DISPLAYS[0];
    const display = MOCK_DISPLAYS.find((item) => item.id === displayId);
    if (!display) throw new Error(`E_DISPLAY_NOT_FOUND: 找不到显示器 ${displayId}`);
    return display;
  };

  const fullscreenViewport = (display: DisplaySummary) => ({
    width: Math.round(display.width / display.scaleFactor),
    height: Math.round(display.height / display.scaleFactor),
    dpr: display.scaleFactor,
  });

  let snapshot: DirectorSnapshot = {
    schemaVersion: 1,
    app: { version: "0.1.0", electron: "45.1.0", chromium: "156.0.8078.49" },
    stage: {
      sceneId: initialScene.id,
      title: initialScene.title,
      url: initialScene.url,
      visible: true,
      blackout: false,
      fullscreen: false,
      displayId: null,
      viewport: { width: 1440, height: 900, dpr: 2 },
    },
    run: {
      mode: "live",
      status: "paused",
      stepIndex: 2,
      stepTotal: initialScene.steps.length,
      steps: buildSteps(initialScene, 2),
      startedAt: new Date(Date.now() - 42_000).toISOString(),
      elapsedMs: 42_300,
    },
    recorder: {
      status: "recording",
      outputPath: "~/Movies/Malo Browser/report-take-01.mp4",
      frames: 412,
      elapsedMs: 13_700,
    },
    error: null,
    scenes: MOCK_SCENES.map(summarize),
    displays: MOCK_DISPLAYS.map((display) => ({ ...display })),
  };

  const clone = (value: DirectorSnapshot): DirectorSnapshot => structuredClone(value);

  const emit = (event: AppEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const publish = (): void => {
    emit({ type: "state.changed", snapshot: clone(snapshot) });
  };

  const findScene = (sceneId: string): MockScene => {
    const scene = MOCK_SCENES.find((item) => item.id === sceneId);
    if (!scene) throw new Error(`E_SCENE_NOT_FOUND: 场景 ${sceneId} 不存在`);
    return scene;
  };

  const currentScene = (): MockScene => findScene(snapshot.stage.sceneId ?? "");

  const setStepStatus = (index: number, patch: Partial<StepRecord>): void => {
    snapshot.run = {
      ...snapshot.run,
      steps: snapshot.run.steps.map((step) => (step.index === index ? { ...step, ...patch } : step)),
    };
  };

  const failStep = (index: number, step: StepRecord): void => {
    const message = `步骤 ${step.id} 在 5000ms 内没有等到目标元素`;
    setStepStatus(index, { status: "failed", detail: message, durationMs: 5000 });
    snapshot.run = { ...snapshot.run, status: "failed" };
    snapshot.error = {
      code: "E_STEP_TIMEOUT",
      message,
      stepIndex: index,
      screenshotPath: `/tmp/demo-stage/${snapshot.stage.sceneId}-step-${index + 1}.png`,
    };
    emit({ type: "step.failed", index, id: step.id, message });
    emit({ type: "app.error", code: "E_STEP_TIMEOUT", message });
    publish();
  };

  const advance = (): void => {
    const total = snapshot.run.stepTotal;
    const index = snapshot.run.stepIndex;
    if (index >= total) return;
    const step = snapshot.run.steps[index];
    if (!step) return;

    const scene = currentScene();
    snapshot.error = null;
    snapshot.run = { ...snapshot.run, status: "running" };
    if (!snapshot.run.startedAt) snapshot.run = { ...snapshot.run, startedAt: new Date().toISOString() };
    setStepStatus(index, { status: "running" });
    emit({ type: "step.started", index, id: step.id, action: step.action });
    publish();

    window.setTimeout(() => {
      if (scene.id === FAILING_STEP.sceneId && step.id === FAILING_STEP.stepId) {
        failStep(index, step);
        return;
      }
      setStepStatus(index, { status: "passed", durationMs: 1200 });
      emit({ type: "step.completed", index, id: step.id, durationMs: 1200 });
      if (index + 1 >= total) {
        snapshot.run = { ...snapshot.run, stepIndex: total, status: "done" };
        emit({ type: "run.completed", stepTotal: total });
      } else {
        snapshot.run = { ...snapshot.run, stepIndex: index + 1 };
      }
      publish();
    }, ACTIVE_STEP_MS);
  };

  const ticker = window.setInterval(() => {
    let changed = false;
    if (snapshot.run.status === "running") {
      snapshot.run = { ...snapshot.run, elapsedMs: snapshot.run.elapsedMs + 1000 };
      changed = true;
    }
    if (snapshot.recorder.status === "recording") {
      snapshot.recorder = {
        ...snapshot.recorder,
        frames: snapshot.recorder.frames + 30,
        elapsedMs: snapshot.recorder.elapsedMs + 1000,
      };
      changed = true;
    }
    if (changed) publish();
  }, 1000);

  window.addEventListener("pagehide", () => window.clearInterval(ticker), { once: true });

  return {
    getSnapshot: () => Promise.resolve(clone(snapshot)),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openPath: (path) => {
      console.info(`[mock] openPath ${path}`);
      return Promise.resolve();
    },
    send: (command) => {
      try {
        switch (command.cmd) {
          case "scene.load": {
            const scene = findScene(command.args.sceneId);
            snapshot.stage = {
              ...snapshot.stage,
              sceneId: scene.id,
              title: scene.title,
              url: scene.url,
            };
            snapshot.run = {
              ...snapshot.run,
              status: "loading",
              stepIndex: 0,
              stepTotal: scene.steps.length,
              steps: buildSteps(scene),
              startedAt: null,
              elapsedMs: 0,
            };
            snapshot.error = null;
            emit({ type: "scene.loading", sceneId: scene.id });
            publish();
            window.setTimeout(() => {
              if (snapshot.stage.sceneId !== scene.id) return;
              snapshot.run = { ...snapshot.run, status: "ready" };
              emit({ type: "scene.ready", sceneId: scene.id, url: scene.url });
              publish();
            }, 400);
            break;
          }
          case "run.start": {
            snapshot.error = null;
            snapshot.run = {
              ...snapshot.run,
              status: "running",
              startedAt: snapshot.run.startedAt ?? new Date().toISOString(),
            };
            publish();
            break;
          }
          case "run.next":
            advance();
            break;
          case "run.prev": {
            const index = Math.max(0, snapshot.run.stepIndex - 1);
            snapshot.error = null;
            setStepStatus(index, { status: "pending", detail: undefined, durationMs: undefined });
            snapshot.run = { ...snapshot.run, stepIndex: index, status: "paused" };
            publish();
            break;
          }
          case "run.pause": {
            snapshot.run = { ...snapshot.run, status: "paused" };
            emit({ type: "run.paused", stepIndex: snapshot.run.stepIndex });
            publish();
            break;
          }
          case "run.resume": {
            snapshot.run = { ...snapshot.run, status: "running" };
            publish();
            break;
          }
          case "run.reset": {
            const scene = currentScene();
            snapshot.error = null;
            snapshot.run = {
              ...snapshot.run,
              status: "ready",
              stepIndex: 0,
              steps: buildSteps(scene),
              startedAt: null,
              elapsedMs: 0,
            };
            publish();
            break;
          }
          case "stage.blackout": {
            snapshot.stage = { ...snapshot.stage, blackout: command.args.on };
            publish();
            break;
          }
          case "stage.fullscreen": {
            const on = command.args.on;
            const display = displayFor(snapshot.stage.displayId);
            snapshot.stage = {
              ...snapshot.stage,
              fullscreen: on,
              viewport: on ? fullscreenViewport(display) : { ...WINDOWED_VIEWPORT },
            };
            emit({
              type: "stage.layout",
              fullscreen: on,
              displayId: snapshot.stage.displayId,
              viewport: { ...snapshot.stage.viewport },
            });
            publish();
            break;
          }
          case "stage.display": {
            const display = displayFor(command.args.displayId);
            snapshot.stage = {
              ...snapshot.stage,
              displayId: command.args.displayId,
              viewport: snapshot.stage.fullscreen ? fullscreenViewport(display) : snapshot.stage.viewport,
            };
            emit({
              type: "stage.layout",
              fullscreen: snapshot.stage.fullscreen,
              displayId: snapshot.stage.displayId,
              viewport: { ...snapshot.stage.viewport },
            });
            publish();
            break;
          }
          case "recorder.start": {
            snapshot.recorder = {
              status: "recording",
              outputPath: `~/Movies/Malo Browser/${snapshot.stage.sceneId}-take-02.mp4`,
              frames: 0,
              elapsedMs: 0,
            };
            emit({ type: "recorder.started", outputPath: snapshot.recorder.outputPath ?? "" });
            publish();
            break;
          }
          case "recorder.stop": {
            snapshot.recorder = { ...snapshot.recorder, status: "idle" };
            emit({
              type: "recorder.stopped",
              outputPath: snapshot.recorder.outputPath ?? "",
              frames: snapshot.recorder.frames,
            });
            publish();
            break;
          }
        }
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
