import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatRelative } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { getProjectRegistry, setProjectActive } from "../lib/ipc";
import { filterProjectRegistry, projectRegistrySummary, splitProjectRegistry } from "../lib/projectRegistry";
import type { ProjectRegistryEntry } from "../types";
import { AppToggle, ErrorBanner, SourceBadge } from "./Shared";
import { errorText } from "../lib/errorText";

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
  const [projects, setProjects] = useState<ProjectRegistryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inactiveOpen, setInactiveOpen] = useState(false);

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

  const visible = useMemo(() => filterProjectRegistry(projects ?? [], query), [projects, query]);
  const { active: activeRows, inactive: inactiveRows } = useMemo(() => splitProjectRegistry(visible), [visible]);
  const searching = query.trim().length > 0;
  const showInactive = inactiveOpen || searching;
  const summary = useMemo(() => projectRegistrySummary(projects ?? []), [projects]);
  const summaryLabel = summary.pending > 0
    ? text(
      `활성 ${summary.active} · 제외 ${summary.inactive} · 결정 대기 ${summary.pending}`,
      `${summary.active} active · ${summary.inactive} excluded · ${summary.pending} pending`,
    )
    : text(`활성 ${summary.active} · 제외 ${summary.inactive}`, `${summary.active} active · ${summary.inactive} excluded`);

  const renderRow = (entry: ProjectRegistryEntry) => (
    <li key={entry.path} className={`project-registry-row${entry.active ? "" : " inactive"}`}>
      <div className="project-registry-main">
        <div className="project-registry-name">
          <strong>{entry.name}</strong>
          {entry.pending && <span className="skill-sync-pill partial">{text("결정 대기", "Needs decision")}</span>}
          {!entry.active && <span className="skill-sync-pill conflict">{text("제외", "Excluded")}</span>}
          {!entry.exists && <span className="skill-sync-pill unmanaged">{text("폴더 없음", "Folder missing")}</span>}
        </div>
        <span className="project-registry-path" title={entry.path}>{entry.path}</span>
        <div className="project-registry-meta">
          {entry.providers.map((provider) => <SourceBadge key={provider} source={provider} />)}
          <span>{text(`세션 ${entry.sessionCount}개`, `${entry.sessionCount} sessions`)}</span>
          {entry.hiddenSessionCount > 0 && (
            <span>{text(`보관함 ${entry.hiddenSessionCount}개`, `${entry.hiddenSessionCount} archived`)}</span>
          )}
          {entry.updatedAt !== null && <span>{formatRelative(entry.updatedAt)}</span>}
        </div>
      </div>
      <AppToggle
        checked={entry.active}
        disabled={busyPath !== null}
        label={text(`${entry.name} 활성`, `${entry.name} active`)}
        onChange={(checked) => { void toggle(entry, checked); }}
      />
    </li>
  );

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
          ) : visible.length === 0 ? (
            <p className="project-registry-empty">
              {projects.length === 0
                ? text("세션에서 확인한 프로젝트가 없습니다.", "No projects have been found in sessions yet.")
                : text("검색 결과가 없습니다.", "No projects match the search.")}
            </p>
          ) : (
            <>
              {activeRows.length > 0 ? (
                <ul className="project-registry-list">
                  {activeRows.map((entry) => renderRow(entry))}
                </ul>
              ) : (
                // 검색이 제외 프로젝트만 맞힌 자리에서 "활성 프로젝트가 없습니다"라고 하면 등록
                // 자체가 없는 것처럼 읽힌다(QA #35). 검색 중에는 검색 기준임을 문구에 밝힌다.
                <p className="project-registry-empty">{searching
                  ? text("검색에 맞는 활성 프로젝트가 없습니다.", "No active projects match the search.")
                  : text("활성 프로젝트가 없습니다.", "No active projects.")}</p>
              )}
              {inactiveRows.length > 0 && (
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
                    onClick={() => setInactiveOpen((current) => !current)}
                  >
                    {showInactive ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                    <strong>{text(`제외 프로젝트 ${inactiveRows.length}개`, `${inactiveRows.length} excluded projects`)}</strong>
                    <small>{searching
                      ? text("검색 중에는 항상 펼칩니다", "Always expanded while searching")
                      : showInactive
                        ? text("접기", "Collapse")
                        : text("펼쳐서 다시 켤 수 있습니다", "Expand to re-enable")}</small>
                  </button>
                  {showInactive && (
                    <ul className="project-registry-list" id="project-registry-inactive-list">
                      {inactiveRows.map((entry) => renderRow(entry))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
