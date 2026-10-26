import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { listProjectEntries, readProjectFile, searchProjectFiles } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { DocumentEntry, ProjectFileSearchHit, ProjectFileSearchPage, ProjectFileView } from "../types";
import { buildProjectFileSearchRequest, unreadContentCount } from "../lib/projectFileSearch";
import { readSecondaryPaneOpen, SECONDARY_PANE_COLLAPSE_MEDIA_QUERY, writeSecondaryPaneOpen } from "../lib/secondaryPane";
import { DocumentTreePane, useRequestGeneration, type DocumentTreeSource } from "./DocumentTreePane";
import { ProjectFilePane } from "./ProjectFilePane";
import { EmptyState, ErrorBanner, LoadingState, useEscapeToClose } from "./Shared";

const PROJECT_FILES_SIDEBAR_OPEN_KEY = "agent-manager.project-files-sidebar";

/**
 * 프로젝트 화면의 파일 탭. 문서 화면의 트리 창(`DocumentTreePane`)을 그대로 쓰되 원천만
 * 프로젝트 목록 IPC로 바꾼다. 검색은 트리 창이 아니라 이 패널이 직접 그린다(F4): 프로젝트
 * 검색은 커서 페이지가 아니라 상한에서 잘리는 한 장이고, 결과 줄에 트리에는 없는 칸
 * (`gitStatus`·`modifiedAt`·`inOverlay`)이 실리기 때문이다.
 *
 * 부르는 쪽이 프로젝트 경로를 `key`로 주어 프로젝트를 바꾸면 통째로 다시 서므로, 여기서는
 * 선택된 파일과 그 본문만 들고 있다. 트리는 펼칠 때 읽으므로 `active`로 막지 않지만, 화면이
 * 숨어 있는 동안에는 파일 본문을 읽지 않는다 — 탭을 돌아왔을 때 마지막 선택을 그때 읽는다.
 */
export function ProjectFilesPanel({ projectPath, active }: { projectPath: string; active: boolean }) {
  const { text } = useI18n();
  const [selected, setSelected] = useState<DocumentEntry | null>(null);
  const [file, setFile] = useState<ProjectFileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRequestGeneration();
  // 검색은 본문 읽기와 세대를 나눠 쓴다. 한 세대를 함께 쓰면 본문을 읽는 사이 검색어를 한 글자
  // 더 치는 것만으로 그 읽기가 낡은 요청이 되어 결과도 `onSettled`도 버려지고, 효과의 의존성은
  // 그대로라 다시 읽지도 않아 "파일을 읽고 있습니다"에서 멈췄다. 반대로 파일을 고르면 진행 중인
  // 검색이 버려져 `searching`이 켜진 채 남았다.
  const searchGeneration = useRequestGeneration();
  const [sidebarOpen, setSidebarOpen] = useState(() => readSecondaryPaneOpen(PROJECT_FILES_SIDEBAR_OPEN_KEY));
  const [sidebarIsOverlay, setSidebarIsOverlay] = useState(() => window.matchMedia(SECONDARY_PANE_COLLAPSE_MEDIA_QUERY).matches);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarRestoreRef = useRef<HTMLButtonElement>(null);
  const sidebarFocusTarget = useRef<"close" | "restore" | null>(null);

  const setSidebarVisibility = (open: boolean) => {
    sidebarFocusTarget.current = open ? "close" : "restore";
    setSidebarOpen(open);
  };

  useEffect(() => writeSecondaryPaneOpen(PROJECT_FILES_SIDEBAR_OPEN_KEY, sidebarOpen), [sidebarOpen]);
  useEffect(() => {
    const query = window.matchMedia(SECONDARY_PANE_COLLAPSE_MEDIA_QUERY);
    const sync = () => setSidebarIsOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useLayoutEffect(() => {
    const target = sidebarFocusTarget.current;
    if (target === null) return;
    sidebarFocusTarget.current = null;
    if (target === "close") sidebarCloseRef.current?.focus();
    else sidebarRestoreRef.current?.focus();
  }, [sidebarOpen]);
  useEscapeToClose(() => setSidebarVisibility(false), sidebarOpen && sidebarIsOverlay);

  const searchLabel = text("파일명 또는 경로 검색", "Search by file name or path");
  const source = useMemo<DocumentTreeSource>(() => ({
    key: projectPath,
    list: (parentPath, cursor, limit) => listProjectEntries({ projectPath, parentPath, cursor, limit }),
    label: text("프로젝트 파일", "Project files"),
  }), [projectPath, text]);

  const [query, setQuery] = useState("");
  // 본문까지 훑을지(F3). 기본이 꺼짐인 것은 Core 와 같은 선택이다 — 본문 검색은 트리를
  // 걸으며 파일을 여는 일이라 파일명 검색과 비용이 다르고, 사람이 명시로 켜야 한다.
  const [searchContents, setSearchContents] = useState(false);
  const [results, setResults] = useState<ProjectFileSearchPage | null>(null);
  const [searching, setSearching] = useState(false);
  // 검색 실패는 검색 창에만 둔다. 본문 오류와 한 칸을 쓰면 검색 실패가 읽는 중인 파일을 실패로
  // 보이게 하고, 파일을 고르는 것이 아직 유효한 검색 실패를 지운다.
  const [searchError, setSearchError] = useState<string | null>(null);

  const trimmed = query.trim();
  useEffect(() => {
    const request = buildProjectFileSearchRequest({ projectPath, query: trimmed, searchContents });
    if (request === null) {
      // 진행 중이던 검색이 비운 뒤에 도착해 목록을 되살리지 않도록 세대를 넘긴다.
      searchGeneration.open();
      setResults(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    // 입력마다 트리를 통째로 훑지 않도록 잠깐 기다린다. 늦게 도착한 응답은
    // `searchGeneration`이 가린다.
    const requestId = searchGeneration.open();
    const timer = setTimeout(() => {
      setSearching(true);
      void searchGeneration.latest(
        requestId,
        () => searchProjectFiles(request),
        {
          onResult: (page) => {
            setResults(page);
            setSearchError(null);
          },
          onError: setSearchError,
          onSettled: () => setSearching(false),
        },
      );
    }, 250);
    return () => clearTimeout(timer);
    // 요청은 효과 안에서 만든다 — 렌더마다 새 객체인 값을 의존성에 걸면 효과가 매번 돈다.
    // `searchContents` 가 의존성에 있어야 스위치를 켠 순간 같은 질의로 다시 검색한다.
  }, [searchGeneration, projectPath, trimmed, searchContents]);

  const selectedPath = selected?.relativePath ?? null;
  useEffect(() => {
    if (!active || selectedPath === null) return;
    // 이미 그 파일을 들고 있으면 다시 읽지 않는다. 탭을 오갈 때마다 같은 본문을 다시
    // 받는 것을 막는다.
    if (file?.relativePath === selectedPath) return;
    const requestId = generation.open();
    setLoading(true);
    setError(null);
    void generation.latest(
      requestId,
      () => readProjectFile({ projectPath, relativePath: selectedPath }),
      {
        onResult: setFile,
        onError: setError,
        onSettled: () => setLoading(false),
      },
    );
  }, [active, file?.relativePath, generation, projectPath, selectedPath]);

  const onSelect = (entry: DocumentEntry) => {
    if (entry.relativePath === selectedPath) return;
    setSelected(entry);
    setFile(null);
    setError(null);
  };

  const restoreSidebar = sidebarOpen ? null : (
    <button
      ref={sidebarRestoreRef}
      className="secondary-pane-restore"
      type="button"
      onClick={() => setSidebarVisibility(true)}
      aria-label={text("파일 탐색기 보기", "Show file explorer")}
      title={text("파일 탐색기 보기", "Show file explorer")}
      aria-expanded={false}
    >
      <PanelLeftOpen size={15} aria-hidden="true" />
      <span>{text("파일", "Files")}</span>
    </button>
  );

  return (
    <div className="docs-layout project-files-layout">
      {sidebarOpen && <aside className="docs-sidebar" id="project-files-sidebar">
        <div className="docs-sidebar-head">
          <div><strong>{text("파일 탐색기", "File explorer")}</strong></div>
          <button
            ref={sidebarCloseRef}
            className="secondary-pane-toggle"
            type="button"
            onClick={() => setSidebarVisibility(false)}
            aria-label={text("파일 탐색기 숨기기", "Hide file explorer")}
            title={text("파일 탐색기 숨기기", "Hide file explorer")}
          >
            <PanelLeftClose size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="doc-tree-panel">
          <label className="document-tree-search">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
            />
          </label>
          <label className="project-search-contents">
            <input
              type="checkbox"
              checked={searchContents}
              onChange={(event) => setSearchContents(event.target.checked)}
            />
            <span>{text("파일 본문도 검색", "Search file contents too")}</span>
          </label>
          {trimmed.length > 0 && searchError && <ErrorBanner message={searchError} />}
          {trimmed.length > 0
            ? <ProjectFileSearchResults
                page={results}
                searching={searching}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            : <DocumentTreePane source={source} selectedPath={selectedPath} onSelect={onSelect} />}
        </div>
      </aside>}
      {sidebarOpen && sidebarIsOverlay && (
        <button
          className="docs-sidebar-backdrop"
          type="button"
          onClick={() => setSidebarVisibility(false)}
          aria-label={text("파일 탐색기 닫기", "Close file explorer")}
        />
      )}
      <main className="doc-workspace">
        {restoreSidebar && file === null && <header className="doc-header doc-header-empty">{restoreSidebar}</header>}
        {error && <ErrorBanner message={error} />}
        {selected === null
          ? <EmptyState title={text("파일을 선택하세요", "Select a file")} detail={text("왼쪽 트리에서 파일을 고르면 읽기 전용으로 보여 줍니다.", "Pick a file in the tree to view it read-only.")} />
          : loading || (file === null && !error)
            ? <LoadingState label={text("파일을 읽고 있습니다", "Reading file")} />
            : file
              ? <ProjectFilePane file={file} headerLeading={restoreSidebar} />
              : null}
      </main>
    </div>
  );
}

/**
 * 검색 결과 목록. 줄마다 경로와 함께 세 칸을 보여 준다(F4) — git 작업 트리 상태, 마지막
 * 수정 시각, overlay 포함 여부. `gitStatusAvailable`이 거짓이면 저장소가 아니거나 상태를
 * 읽지 못한 것이므로 "변경 없음"으로 보이지 않도록 상태 칸 자체를 그리지 않는다.
 */
function ProjectFileSearchResults({
  page,
  searching,
  selectedPath,
  onSelect,
}: {
  page: ProjectFileSearchPage | null;
  searching: boolean;
  selectedPath: string | null;
  onSelect: (entry: ProjectFileSearchHit) => void;
}) {
  const { text } = useI18n();
  const unread = unreadContentCount(page);
  if (searching && !page) return <LoadingState label={text("파일을 검색하고 있습니다", "Searching files")} />;
  if (!page) return null;
  if (page.entries.length === 0) {
    return <p className="tree-empty">{text("조건에 맞는 파일이 없습니다.", "No files match your search.")}</p>;
  }
  return (
    <div className="document-search-results" aria-live="polite">
      {page.entries.map((hit) => (
        <button
          key={hit.relativePath}
          type="button"
          className={selectedPath === hit.relativePath ? "document-search-row active" : "document-search-row"}
          onClick={() => onSelect(hit)}
        >
          <span className="document-search-path">{hit.relativePath}</span>
          <span className="document-search-meta">
            {page.gitStatusAvailable && hit.gitStatus
              ? <span className="badge">{hit.gitStatus}</span>
              : null}
            {hit.inOverlay ? <span className="badge">{text("오버레이", "Overlay")}</span> : null}
            <time dateTime={new Date(hit.modifiedAt).toISOString()}>
              {new Date(hit.modifiedAt).toLocaleDateString()}
            </time>
          </span>
        </button>
      ))}
      {unread > 0
        ? <p className="tree-empty">{text(`${unread}개 파일은 본문을 열지 않았습니다 — 제외 폴더·1MB 초과·바이너리입니다.`, `${unread} file(s) were not opened — excluded folders, over 1MB, or binary.`)}</p>
        : null}
      {page.truncated
        ? <p className="tree-empty">{text("결과가 상한에서 잘렸습니다. 검색어를 좁혀 주세요.", "Results were capped. Narrow the query.")}</p>
        : null}
    </div>
  );
}
