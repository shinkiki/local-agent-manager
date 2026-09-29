import { FolderTree, GitBranch, Settings } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import { getProjectRegistry } from "../lib/ipc";
import { resolveSelectedProjectPath } from "../lib/projectSelection";
import { readStoredText, writeStoredText } from "../lib/storedText";
import type { TabRequest } from "../lib/uiGuide";
import type { ProjectRegistryEntry } from "../types";
import { ProjectFilesPanel } from "./ProjectFilesPanel";
import { ProjectGitPanel } from "./ProjectGitPanel";
import { ProjectRegistryCard } from "./ProjectRegistryCard";
import { SettingsSubTabPanel, SettingsSubTabs, type SettingsSubTab } from "./SettingsSubTabs";
import { EmptyState, ErrorBanner, LoadingState } from "./Shared";
import { useStoredChoice } from "./SkillLibraryPanel";

export type ProjectsTabId = "files" | "git" | "settings";

// 키에 "settings"가 들어가면 안 된다 — 설정 화면은 탭을 저장하지 않는다는 성질을 E2E가
// "settings와 tab을 함께 담은 localStorage 키가 없다"로 보고 있다(am20260907-settings-tab-retention).
const PROJECTS_TAB_KEY = "agent-manager.projects-tab.v1";
/** 파일·형상관리 탭이 함께 쓰는 선택 프로젝트. 새로고침을 건너 복원된다. */
const PROJECTS_SELECTED_PATH_KEY = "agent-manager.projects-selected-path.v1";

const projectsTabs: readonly SettingsSubTab<ProjectsTabId>[] = [
  { id: "files", icon: FolderTree, ko: "프로젝트", en: "Files", anchor: "projects.tab.files" },
  { id: "git", icon: GitBranch, ko: "형상관리", en: "Source control", anchor: "projects.tab.git" },
  { id: "settings", icon: Settings, ko: "설정", en: "Settings", anchor: "projects.tab.settings" },
];

const PROJECTS_TAB_IDS: readonly ProjectsTabId[] = projectsTabs.map((tab) => tab.id);

/**
 * 주 메뉴의 프로젝트 화면. 세션에서 확인한 등록 프로젝트 가운데 활성이고 폴더가 있는 것만
 * 고를 수 있고, 파일 탭은 그 폴더를 읽기 전용으로, 형상관리 탭은 git 상태를 보여 준다. 설정
 * 탭은 설정 → 라이브러리에 있던 프로젝트 활성여부 카드를 그대로 옮겨 온 것이다 — 활성여부를
 * 정하는 자리와 그 결과로 고를 수 있는 목록이 한 화면에 있어야 "왜 이 프로젝트가 없지"에
 * 바로 답한다.
 *
 * 등록부는 화면이 뜰 때와 `registryRevision`이 바뀔 때 다시 읽는다. 설정 탭의 토글은
 * `onRegistryChanged`로 앱의 자원 화면들을 무효화하고, 그 회전값이 다시 이리로 돌아와 선택
 * 목록을 새로 읽는다.
 */
export function ProjectsView({ active, tabRequest = null, registryRevision, onRegistryChanged }: {
  active: boolean;
  tabRequest?: TabRequest<ProjectsTabId> | null;
  registryRevision: number;
  onRegistryChanged: () => void;
}) {
  const { text } = useI18n();
  const [tab, setTab] = useStoredChoice<ProjectsTabId>(PROJECTS_TAB_KEY, PROJECTS_TAB_IDS, "files");
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest, setTab]);

  const registry = useProjectRegistry(registryRevision);
  const activeProjects = useMemo(
    () => (registry.entries ?? []).filter((entry) => entry.active && entry.exists),
    [registry.entries],
  );
  const [storedPath, setStoredPath] = useState<string | null>(() => readStoredText(PROJECTS_SELECTED_PATH_KEY));
  const selectedPath = resolveSelectedProjectPath(activeProjects, storedPath);
  const selectProject = (path: string) => {
    setStoredPath(path);
    writeStoredText(PROJECTS_SELECTED_PATH_KEY, path);
  };

  const needsProject = tab === "files" || tab === "git";
  return (
    // 파일·형상관리 탭은 창 높이를 채우고 안에서 스크롤하지만, 설정 탭은 카드가 흐르며
    // 바깥 패널이 스크롤한다 — 높이를 고정하면 설정 탭의 긴 목록이 잘린다.
    <div className={`settings-subtab-view projects-view${needsProject ? " projects-view-fill" : ""}`}>
      <SettingsSubTabs idPrefix="projects" tabs={projectsTabs} value={tab} onChange={setTab} label={text("프로젝트 화면 탭", "Projects view tabs")} />
      {needsProject && selectedPath !== null ? (
        <label className="projects-selector" data-ui-anchor="projects.selector">
          <span>{text("프로젝트", "Project")}</span>
          <select aria-label={text("프로젝트 선택", "Select project")} value={selectedPath} onChange={(event) => selectProject(event.target.value)}>
            {activeProjects.map((project) => (
              <option value={project.path} key={project.path}>{project.name} · {project.path}</option>
            ))}
          </select>
        </label>
      ) : null}
      <SettingsSubTabPanel idPrefix="projects" id="files" active={tab === "files"}>
        <ProjectPanelBody registry={registry} selectedPath={selectedPath} onOpenSettings={() => setTab("settings")}>
          {(path) => <ProjectFilesPanel key={path} projectPath={path} active={active && tab === "files"} />}
        </ProjectPanelBody>
      </SettingsSubTabPanel>
      <SettingsSubTabPanel idPrefix="projects" id="git" active={tab === "git"}>
        <ProjectPanelBody registry={registry} selectedPath={selectedPath} onOpenSettings={() => setTab("settings")}>
          {(path) => <ProjectGitPanel key={path} projectPath={path} active={active && tab === "git"} />}
        </ProjectPanelBody>
      </SettingsSubTabPanel>
      <SettingsSubTabPanel idPrefix="projects" id="settings" active={tab === "settings"}>
        <ProjectRegistryCard onChanged={onRegistryChanged} />
      </SettingsSubTabPanel>
    </div>
  );
}

interface ProjectRegistryState {
  entries: ProjectRegistryEntry[] | null;
  error: string | null;
}

/** 등록부를 읽는다. 회전값이 바뀔 때마다 다시 읽고, 늦게 온 응답은 버린다. */
function useProjectRegistry(revision: number): ProjectRegistryState {
  const [state, setState] = useState<ProjectRegistryState>({ entries: null, error: null });
  useEffect(() => {
    let live = true;
    getProjectRegistry()
      .then((entries) => {
        if (live) setState({ entries, error: null });
      })
      .catch((cause: unknown) => {
        if (live) setState((current) => ({ entries: current.entries, error: errorText(cause) }));
      });
    return () => { live = false; };
  }, [revision]);
  return state;
}

/**
 * 파일·형상관리 탭이 같은 순서로 거치는 상태. 등록부를 아직 못 받았으면 진행 표시, 실패면
 * 오류 배너, 활성 프로젝트가 없으면 설정 탭으로 보내는 빈 상태, 그 다음에야 고른 프로젝트의
 * 패널이다. 두 탭이 이 네 갈래를 각자 적으면 한쪽만 빈 상태 안내를 빠뜨린다.
 */
function ProjectPanelBody({ registry, selectedPath, onOpenSettings, children }: {
  registry: ProjectRegistryState;
  selectedPath: string | null;
  onOpenSettings: () => void;
  children: (path: string) => ReactNode;
}) {
  const { text } = useI18n();
  if (registry.error && registry.entries === null) return <ErrorBanner message={registry.error} />;
  if (registry.entries === null) return <LoadingState label={text("프로젝트 목록을 읽고 있습니다", "Loading projects")} />;
  if (selectedPath === null) {
    return (
      <div className="projects-empty">
        <EmptyState
          title={text("활성 프로젝트가 없습니다", "No active projects")}
          detail={text("설정 탭에서 세션에서 확인한 프로젝트를 활성으로 두면 여기서 고를 수 있습니다.", "Mark a project found in sessions as active in the Settings tab to pick it here.")}
        />
        <button className="button secondary" type="button" onClick={onOpenSettings}>{text("설정 탭 열기", "Open Settings tab")}</button>
      </div>
    );
  }
  return (
    <>
      {registry.error && <ErrorBanner message={registry.error} />}
      {children(selectedPath)}
    </>
  );
}
