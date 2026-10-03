import { useEffect, useMemo, useState } from "react";
import { listProjectEntries, readProjectFile, searchProjectFiles } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { DocumentEntry, ProjectFileSearchHit, ProjectFileSearchPage, ProjectFileView } from "../types";
import { DocumentTreePane, useRequestGeneration, type DocumentTreeSource } from "./DocumentTreePane";
import { ProjectFilePane } from "./ProjectFilePane";
import { EmptyState, ErrorBanner, LoadingState } from "./Shared";

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

  const searchLabel = text("파일명 또는 경로 검색", "Search by file name or path");
  const source = useMemo<DocumentTreeSource>(() => ({
    key: projectPath,
    list: (parentPath, cursor, limit) => listProjectEntries({ projectPath, parentPath, cursor, limit }),
    label: text("프로젝트 파일", "Project files"),
  }), [projectPath, text]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectFileSearchPage | null>(null);
  const [searching, setSearching] = useState(false);

  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length === 0) {
      setResults(null);
      return;
    }
    // 입력마다 트리를 통째로 훑지 않도록 잠깐 기다린다. 늦게 도착한 응답은
    // `generation`이 가린다.
    const requestId = generation.open();
    const timer = setTimeout(() => {
      setSearching(true);
      void generation.latest(
        requestId,
        () => searchProjectFiles({ projectPath, query: trimmed }),
        {
          onResult: setResults,
          onError: setError,
          onSettled: () => setSearching(false),
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [generation, projectPath, trimmed]);

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

  return (
    <div className="docs-layout project-files-layout">
      <aside className="docs-sidebar">
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
          {trimmed.length > 0
            ? <ProjectFileSearchResults
                page={results}
                searching={searching}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            : <DocumentTreePane source={source} selectedPath={selectedPath} onSelect={onSelect} />}
        </div>
      </aside>
      <main className="doc-workspace">
        {error && <ErrorBanner message={error} />}
        {selected === null
          ? <EmptyState title={text("파일을 선택하세요", "Select a file")} detail={text("왼쪽 트리에서 파일을 고르면 읽기 전용으로 보여 줍니다.", "Pick a file in the tree to view it read-only.")} />
          : loading || (file === null && !error)
            ? <LoadingState label={text("파일을 읽고 있습니다", "Reading file")} />
            : file
              ? <ProjectFilePane file={file} />
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
      {page.truncated
        ? <p className="tree-empty">{text("결과가 상한에서 잘렸습니다. 검색어를 좁혀 주세요.", "Results were capped. Narrow the query.")}</p>
        : null}
    </div>
  );
}
