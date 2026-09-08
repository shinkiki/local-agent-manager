import { FolderPlus } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { ProjectRegistryEntry } from "../types";
import { Modal, SourceBadge } from "./Shared";

/**
 * 새로 감지된 프로젝트의 초기값(활성 유지/제외)을 묻는 알림. 프로젝트는 이미 활성으로 보이는
 * 상태이고, 여기서 정한 값은 설정 › 라이브러리에서 언제든 바꿀 수 있다. "나중에"는 이번
 * 집합에 대해서만 닫고, 다른 프로젝트가 더 감지되면 다시 뜬다.
 */
export function NewProjectsModal({ projects, busyPath, onDecide, onKeepAll, onLater }: {
  projects: ProjectRegistryEntry[];
  /** 결정 요청이 진행 중인 경로("*"는 전체). 진행 중에는 버튼을 잠근다. */
  busyPath: string | null;
  onDecide: (entry: ProjectRegistryEntry, active: boolean) => void;
  onKeepAll: () => void;
  onLater: () => void;
}) {
  const { text } = useI18n();
  const busy = busyPath !== null;
  return (
    <Modal
      title={<><FolderPlus size={16} aria-hidden="true" /> {text("새 프로젝트 감지", "New projects detected")}</>}
      onClose={onLater}
      footer={<>
        <button className="button" type="button" disabled={busy} onClick={onLater}>{text("나중에", "Later")}</button>
        <button className="button primary" type="button" disabled={busy} onClick={onKeepAll}>{text("모두 활성 유지", "Keep all active")}</button>
      </>}
    >
      <p className="new-projects-intro">{text(
        "세션에서 새 프로젝트를 확인했습니다. 지금은 활성 상태로 보이며, 제외하면 세션·스킬·지침·대시보드에서 빠집니다. 설정 › 라이브러리에서 언제든 바꿀 수 있습니다.",
        "New projects were found in sessions. They are active right now; excluding one removes it from sessions, skills, instructions, and the dashboard. You can change this any time in Settings › Library.",
      )}</p>
      <ul className="new-projects-list">
        {projects.map((entry) => (
          <li key={entry.path} className="new-projects-row">
            <div className="project-registry-main">
              <div className="project-registry-name"><strong>{entry.name}</strong></div>
              <span className="project-registry-path" title={entry.path}>{entry.path}</span>
              <div className="project-registry-meta">
                {entry.providers.map((provider) => <SourceBadge key={provider} source={provider} />)}
                <span>{text(`세션 ${entry.sessionCount}개`, `${entry.sessionCount} sessions`)}</span>
              </div>
            </div>
            <div className="new-projects-actions">
              <button className="button" type="button" disabled={busy} onClick={() => onDecide(entry, false)}>{text("제외", "Exclude")}</button>
              <button className="button primary" type="button" disabled={busy} onClick={() => onDecide(entry, true)}>{text("활성 유지", "Keep active")}</button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
