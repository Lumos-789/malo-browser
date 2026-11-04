import type { DirectorSceneSummary } from "../../../preload/director-api";
import { pad2 } from "./format";

type Props = {
  scenes: DirectorSceneSummary[];
  currentId: string | null;
  onSelect: (sceneId: string) => void;
};

export function SceneList({ scenes, currentId, onSelect }: Props) {
  if (scenes.length === 0) {
    return <p className="empty">未收到场景列表</p>;
  }

  return (
    <ul className="scene-list">
      {scenes.map((scene, index) => {
        const current = scene.id === currentId;
        const tooltip = scene.description ? `${scene.title} · ${scene.description}` : scene.title;
        return (
          <li key={scene.id}>
            <button
              type="button"
              className={current ? "scene-item is-current" : "scene-item"}
              aria-current={current ? "true" : undefined}
              title={tooltip}
              onClick={() => onSelect(scene.id)}
            >
              <span className="scene-no mono">{pad2(index + 1)}</span>
              <span className="scene-body">
                <span className="scene-title">{scene.title}</span>
                {scene.description ? <span className="scene-desc">{scene.description}</span> : null}
                <span className="scene-meta mono">
                  {scene.stepTotal} 步{scene.profile ? ` · ${scene.profile}` : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
