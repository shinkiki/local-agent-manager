import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRelative } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { getProjectRegistry, setProjectActive } from "../lib/ipc";
import { filterProjectRegistry, projectRegistrySummary, splitProjectRegistry } from "../lib/projectRegistry";
import type { ProjectRegistryEntry } from "../types";
import { AppToggle, ErrorBanner, SourceBadge } from "./Shared";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";

/**
 * 프로젝트 등록부의 비동기 목록 조회와 활성 토글 상태를 관리한다.
 * 요청 중인 경로(`busyPath`)와 오류를 들고, 토글 성공 시 `onChanged` 콜백을 호출한다.
 */
function useProjectRegistryState(onChanged?: () => void) {
  const [projects, setProjects] = useState<ProjectRegistryEntry[] | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getProjectRegistry()
      .then((entries) => {
        if (!active) return;
        setProjects(entries);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => { active = false; };
  }, []);

  const toggle = useCallback(async (entry: ProjectRegistryEntry, active: boolean) => {
    setBusyPath(entry.path);
    setError(null);
    try {
      setProjects(await setProjectActive({ path: entry.path, active }));
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyPath(null);
    }
  }, [onChanged]);

  return { projects, busyPath, error, toggle };
}

/**
 * 제외된 프로젝트 목록을 담는 접이식 구역. 검색 중에는 항상 펼쳐지며 접기 버튼이 잠긴다.
 */
function ProjectRegistryInactiveSection({
  entries,
  busy,
  searching,
  open,
  onToggleOpen,
  onToggleEntry,
}: {
  entries: ProjectRegistryEntry[];
  busy: boolean;
  searching: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onToggleEntry: (entry: ProjectRegistryEntry, active: boolean) => Promise<void>;
}) {
  const { text } = useI18n();
  const showInactive = open || searching;

  return (
    <div className="project-registry-inactive">
      <button
        className="project-registry-collapse"
        type="button"
        aria-expanded={showInactive}
        aria-controls="project-registry-inactive-list"
        // 검색 중에는 제외 목록이 언제나 펼쳐진다. 그때 누르면 화면은 그대로인데
        // inactiveOpen만 뒤집혀, 검색을 지운 뒤 접혀 있어야 할 목록이 펼쳐진 채로
        // 남았다(QA #15). 접을 수 없는 상태에서는 접기 조작 자체를 내주지 않는다.
        disabled={searching}
        onClick={onToggleOpen}
      >
        {showInactive ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <strong>{text(`제외 프로젝트 ${entries.length}개`, `${entries.length} excluded projects`)}</strong>
        <small>{searching
          ? text("검색 중에는 항상 펼칩니다", "Always expanded while searching")
          : showInactive
            ? text("접기", "Collapse")
            : text("펼쳐서 다시 켤 수 있습니다", "Expand to re-enable")}</small>
      </button>
      {showInactive && (
        <ProjectRegistryList
          entries={entries}
          busy={busy}
          id="project-registry-inactive-list"
          onToggle={onToggleEntry}
        />
      )}
    </div>
  );
}

/**
 * 검색 결과의 빈 상태와 활성·제외 목록 배치를 한곳에서 결정한다. 카드 본문은 조회 상태와
 * 검색 조건을 조립하고, 이 컴포넌트는 이미 나뉜 결과를 같은 순서로 그리는 역할만 맡는다.
 */
function ProjectRegistryResults({
  projectCount,
  activeRows,
  inactiveRows,
  busy,
  searching,
  inactiveOpen,
  onToggleInactive,
  onToggleEntry,
}: {
  projectCount: number;
  activeRows: ProjectRegistryEntry[];
  inactiveRows: ProjectRegistryEntry[];
  busy: boolean;
  searching: boolean;
  inactiveOpen: boolean;
  onToggleInactive: () => void;
  onToggleEntry: (entry: ProjectRegistryEntry, active: boolean) => Promise<void>;
}) {
  const { text } = useI18n();

  if (activeRows.length === 0 && inactiveRows.length === 0) {
    return (
      <p className="project-registry-empty">
        {projectCount === 0
          ? text("세션에서 확인한 프로젝트가 없습니다.", "No projects have been found in sessions yet.")
          : text("검색 결과가 없습니다.", "No projects match the search.")}
      </p>
    );
  }

  return (
    <>
      {activeRows.length > 0 ? (
        <ProjectRegistryList entries={activeRows} busy={busy} onToggle={onToggleEntry} />
      ) : (
        // 검색이 제외 프로젝트만 맞힌 자리에서 "활성 프로젝트가 없습니다"라고 하면 등록
        // 자체가 없는 것처럼 읽힌다(QA #35). 검색 중에는 검색 기준임을 문구에 밝힌다.
        <p className="project-registry-empty">{searching
          ? text("검색에 맞는 활성 프로젝트가 없습니다.", "No active projects match the search.")
          : text("활성 프로젝트가 없습니다.", "No active projects.")}</p>
      )}
      {inactiveRows.length > 0 && (
        <ProjectRegistryInactiveSection
          entries={inactiveRows}
          busy={busy}
          searching={searching}
          open={inactiveOpen}
          onToggleOpen={onToggleInactive}
          onToggleEntry={onToggleEntry}
        />
      )}
    </>
  );
}

/**
 * 설정 › 라이브러리 탭의 프로젝트 활성여부 카드. 프로젝트는 세션 cwd에서 역산되므로 등록·삭제가
 * 없고, 이 카드는 제외 여부만 정한다. 제외한 프로젝트의 세션은 백엔드가 스냅샷 합성 단계에서
 * 걷어내 세션·스킬·지침·대시보드·새 채팅 목록에서 함께 사라진다. 스냅샷은 그 결과라 전체
 * 목록은 `get_project_registry`로 따로 읽는다. 토글은 되돌릴 수 있어 확인창을 두지 않는다.
 * 제외 프로젝트는 활성 목록 아래 접이식 목록(기본 접힘)에 두고, 검색 중에는 검색 결과가
 * 숨어 있지 않도록 자동으로 펼친다.
 */
export function ProjectRegistryCard({ onChanged }: {
  /** 활성여부가 바뀐 뒤 스냅샷·스킬·지침을 다시 읽게 한다. */
  onChanged?: () => void;
}) {
  const { text } = useI18n();
  const { projects, busyPath, error, toggle } = useProjectRegistryState(onChanged);
  const [query, setQuery] = useState("");
  const [inactiveOpen, setInactiveOpen] = useState(false);

  const visible = useMemo(() => filterProjectRegistry(projects ?? [], query), [projects, query]);
  const { active: activeRows, inactive: inactiveRows } = useMemo(() => splitProjectRegistry(visible), [visible]);
  const searching = query.trim().length > 0;
  const summary = useMemo(() => projectRegistrySummary(projects ?? []), [projects]);
  const summaryLabel = summary.pending > 0
    ? text(
      `활성 ${summary.active} · 제외 ${summary.inactive} · 결정 대기 ${summary.pending}`,
      `${summary.active} active · ${summary.inactive} excluded · ${summary.pending} pending`,
    )
    : text(`활성 ${summary.active} · 제외 ${summary.inactive}`, `${summary.active} active · ${summary.inactive} excluded`);

  return (
    <section className="settings-card">
      <header>
        <div>
          <span>{text("프로젝트 활성여부", "Project activation")}</span>
          <h2>{text("세션에서 확인한 프로젝트", "Projects found in sessions")}</h2>
        </div>
        <p>{text(
          "제외한 프로젝트는 세션·보관함·스킬·지침·대시보드·새 채팅 프로젝트 목록에서 사라집니다. 파일과 이미 저장된 반복 요청은 변경되지 않으며, 다시 켜면 그대로 돌아옵니다. 새로 감지된 프로젝트는 활성으로 시작하고 알림으로 초기값을 묻습니다.",
          "Excluded projects disappear from sessions, the archive, skills, instructions, the dashboard, and the new-chat project list. Files and saved recurring requests are left untouched, and re-enabling restores everything. Newly detected projects start active and an alert asks for their initial setting.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("프로젝트 목록", "Projects")}</strong>
              <small>{projects ? summaryLabel : "-"}</small>
            </div>
            <label className="project-registry-search">
              <Search size={13} aria-hidden="true" />
              <input
                className="search-input"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={text("이름·경로 검색", "Search name or path")}
                aria-label={text("프로젝트 검색", "Search projects")}
                disabled={!projects}
              />
            </label>
          </header>
          {error && <ErrorBanner message={error} />}
          {!projects ? (
            <p className="settings-storage-note">{text("프로젝트 목록을 불러오는 중…", "Loading projects…")}</p>
          ) : (
            <ProjectRegistryResults
              projectCount={projects.length}
              activeRows={activeRows}
              inactiveRows={inactiveRows}
              busy={busyPath !== null}
              searching={searching}
              inactiveOpen={inactiveOpen}
              onToggleInactive={() => setInactiveOpen((current) => !current)}
              onToggleEntry={toggle}
            />
          )}
        </section>
      </div>
    </section>
  );
}

function ProjectRegistryList({ entries, busy, id, onToggle }: {
  entries: ProjectRegistryEntry[];
  busy: boolean;
  id?: string;
  onToggle: (entry: ProjectRegistryEntry, active: boolean) => Promise<void>;
}) {
  return (
    <ul className="project-registry-list" id={id}>
      {entries.map((entry) => (
        <ProjectRegistryRow entry={entry} busy={busy} key={entry.path} onToggle={onToggle} />
      ))}
    </ul>
  );
}

/**
 * 프로젝트 행의 기본 정보 영역(이름, 상태 배지, 경로, 제공자 배지 및 세션 메타 정보).
 * 설정의 프로젝트 등록 카드와 새 프로젝트 감지 모달에서 공용으로 사용한다.
 */
export function ProjectRegistryMain({
  entry,
  showStatusBadges = false,
  showExtendedMeta = false,
}: {
  entry: ProjectRegistryEntry;
  /** 결정 대기·제외·폴더 없음 상태 배지를 표시할지 여부 */
  showStatusBadges?: boolean;
  /** 보관함 세션 수 및 최근 수정 일시 표시 여부 */
  showExtendedMeta?: boolean;
}) {
  const { text } = useI18n();
  return (
    <div className="project-registry-main">
      <div className="project-registry-name">
        <strong>{displayPath(entry.name)}</strong>
        {showStatusBadges && (
          <>
            {entry.pending && <span className="skill-sync-pill partial">{text("결정 대기", "Needs decision")}</span>}
            {!entry.active && <span className="skill-sync-pill conflict">{text("제외", "Excluded")}</span>}
            {!entry.exists && <span className="skill-sync-pill unmanaged">{text("폴더 없음", "Folder missing")}</span>}
          </>
        )}
      </div>
      <span className="project-registry-path" title={displayPath(entry.path)}>{displayPath(entry.path)}</span>
      <div className="project-registry-meta">
        {entry.providers.map((provider) => <SourceBadge key={provider} source={provider} />)}
        <span>{text(`세션 ${entry.sessionCount}개`, `${entry.sessionCount} sessions`)}</span>
        {showExtendedMeta && (
          <>
            {entry.hiddenSessionCount > 0 && (
              <span>{text(`보관함 ${entry.hiddenSessionCount}개`, `${entry.hiddenSessionCount} archived`)}</span>
            )}
            {entry.updatedAt !== null && <span>{formatRelative(entry.updatedAt)}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function ProjectRegistryRow({ entry, busy, onToggle }: {
  entry: ProjectRegistryEntry;
  busy: boolean;
  onToggle: (entry: ProjectRegistryEntry, active: boolean) => Promise<void>;
}) {
  const { text } = useI18n();
  return (
    <li className={`project-registry-row${entry.active ? "" : " inactive"}`}>
      <ProjectRegistryMain entry={entry} showStatusBadges showExtendedMeta />
      <AppToggle
        checked={entry.active}
        disabled={busy}
        label={text(`${entry.name} 활성`, `${entry.name} active`)}
        onChange={(checked) => { void onToggle(entry, checked); }}
      />
    </li>
  );
}
