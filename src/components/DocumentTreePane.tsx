import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  FileWarning,
  Folder,
  Search,
} from "lucide-react";
import { listDocumentEntries, searchDocumentEntries } from "../lib/ipc";
import {
  documentEntriesForParent,
  mergeDocumentEntries,
  mergeDocumentEntryPage,
  type DocumentTreeCache,
} from "../lib/documentWorkspace";
import type { DocumentEntry, DocumentEntryPage } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";
import { errorText } from "../lib/errorText";

const PAGE_SIZE = 200;
const SEARCH_DELAY_MS = 180;

export interface DocumentTreePaneProps {
  rootId: string;
  selectedPath: string | null;
  onSelect: (entry: DocumentEntry) => void;
}

interface SearchPageState extends DocumentEntryPage {
  query: string;
}

export function DocumentTreePane({ rootId, selectedPath, onSelect }: DocumentTreePaneProps) {
  const [cache, setCache] = useState<DocumentTreeCache>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingParents, setLoadingParents] = useState<ReadonlySet<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const rootGenerationRef = useRef(0);

  const fetchFolder = useCallback(async (
    parentPath: string,
    cursor: string | null,
    generation: number,
  ) => {
    setLoadingParents((current) => withSetMember(current, parentPath, true));
    setTreeError(null);
    try {
      const page = await listDocumentEntries(rootId, parentPath, cursor, PAGE_SIZE);
      if (generation !== rootGenerationRef.current) return;
      setCache((current) => mergeDocumentEntryPage(current, parentPath, page, cursor !== null));
    } catch (cause) {
      if (generation !== rootGenerationRef.current) return;
      setTreeError(errorText(cause));
    } finally {
      if (generation === rootGenerationRef.current) {
        setLoadingParents((current) => withSetMember(current, parentPath, false));
      }
    }
  }, [rootId]);

  useEffect(() => {
    const generation = ++rootGenerationRef.current;
    setCache(new Map());
    setExpanded(new Set());
    setLoadingParents(new Set());
    setTreeError(null);
    void fetchFolder("", null, generation);
  }, [fetchFolder, rootId]);

  // 훅 호출은 폴더 전환 효과보다 뒤에 두어야 한다 — 검색 초기화가 트리 초기화보다 먼저
  // 돌면 폴더를 바꾼 첫 배치에서 트리와 검색의 갱신 순서가 예전과 어긋난다.
  const search = useDocumentEntrySearch(rootId);

  const toggleFolder = (entry: DocumentEntry) => {
    const willExpand = !expanded.has(entry.relativePath);
    setExpanded((current) => withSetMember(current, entry.relativePath, willExpand));
    if (willExpand && !cache.has(entry.relativePath)) {
      void fetchFolder(entry.relativePath, null, rootGenerationRef.current);
    }
  };

  const rootEntries = useMemo(() => documentEntriesForParent(cache, ""), [cache]);
  const rootPage = cache.get("");

  return (
    <section className="document-tree-pane" aria-label="등록 폴더 파일">
      <label className="document-tree-search">
        <Search size={14} aria-hidden="true" />
        <input
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          placeholder="파일명 또는 경로 검색"
          aria-label="파일명 또는 경로 검색"
        />
      </label>
      {search.active ? (
        <div className="document-search-results" aria-live="polite">
          {search.error && <ErrorBanner message={search.error} />}
          {search.firstPageLoading ? <LoadingState label="파일을 검색하고 있습니다" /> : null}
          {search.results?.entries.map((entry) => (
            <button
              className={selectedPath === entry.relativePath ? "document-search-row active" : "document-search-row"}
              type="button"
              key={entry.relativePath}
              onClick={() => entry.isDirectory ? toggleFolder(entry) : onSelect(entry)}
            >
              <DocumentEntryIcon entry={entry} />
              <span><strong>{entry.name}</strong><code>{entry.relativePath}</code></span>
            </button>
          ))}
          {!search.searching && search.results?.entries.length === 0
            ? <p className="tree-empty">조건에 맞는 파일이 없습니다.</p>
            : null}
          {search.results?.nextCursor && (
            <button className="button document-tree-more" type="button" disabled={search.searching} onClick={() => void search.loadMore()}>
              {search.searching ? "불러오는 중…" : `검색 결과 더 보기 (${search.results.entries.length}/${search.results.total})`}
            </button>
          )}
        </div>
      ) : (
        <div className="document-tree-scroll">
          {treeError && <ErrorBanner message={treeError} />}
          {!rootPage && loadingParents.has("") ? <LoadingState label="파일 목록을 읽고 있습니다" /> : null}
          {rootPage && rootEntries.length === 0 ? <p className="tree-empty">표시할 파일이 없습니다.</p> : null}
          <DocumentTreeRows
            view={{
              cache,
              expanded,
              loadingParents,
              selectedPath,
              onSelect,
              onToggle: toggleFolder,
              onLoadMore: (parentPath, cursor) => void fetchFolder(parentPath, cursor, rootGenerationRef.current),
            }}
            parentPath=""
          />
        </div>
      )}
    </section>
  );
}

/**
 * 파일 검색 한 벌. 검색어·결과 쪽수·진행 표시·오류·요청번호가 트리 페이징 상태와 한
 * 컴포넌트에 섞여 있었고, 늦게 도착한 결과를 가리는 `searchPage.query === normalizedQuery`
 * 대조가 렌더와 더 보기에 다섯 번 흩어져 있었다. 대조를 훅 안으로 들여 `results`는 지금
 * 검색어의 결과일 때만 값을 갖게 하고, 트리 창은 그 결과를 그리는 일만 맡는다.
 *
 * 폴더가 바뀌면 검색어까지 비우는 것은 예전 동작 그대로다.
 */
function useDocumentEntrySearch(rootId: string) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<SearchPageState | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const normalizedQuery = query.trim();

  // 결과를 비우는 자리가 둘(폴더 전환·검색어 지움)이라 같은 세 상태를 같은 순서로 나열했다.
  // 요청번호는 부르는 자리가 이미 올려 두므로 여기서는 건드리지 않는다.
  const clear = () => {
    setPage(null);
    setError(null);
    setSearching(false);
  };

  /**
   * 결과를 읽어 오는 두 자리(입력 디바운스·더 보기)가 요청번호 대조·오류 표시·진행 표시
   * 끄기를 각각 나열했다. 커서가 있을 때만 앞서 받은 결과 뒤에 이어 붙이는 것이 유일한
   * 차이다. 진행 표시를 켜는 것은 디바운스 시점이 자리마다 달라 부르는 쪽에 남긴다.
   */
  const fetchPage = useCallback(async (
    searchQuery: string,
    cursor: string | null,
    requestId: number,
  ) => {
    try {
      const next = await searchDocumentEntries(rootId, searchQuery, cursor, PAGE_SIZE);
      if (requestId !== requestRef.current) return;
      setPage((current) => cursor && current?.query === searchQuery
        ? { ...next, query: searchQuery, entries: mergeDocumentEntries(current.entries, next.entries) }
        : { ...next, query: searchQuery });
    } catch (cause) {
      if (requestId === requestRef.current) setError(errorText(cause));
    } finally {
      if (requestId === requestRef.current) setSearching(false);
    }
  }, [rootId]);

  useEffect(() => {
    requestRef.current += 1;
    setQuery("");
    clear();
  }, [rootId]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    if (!normalizedQuery) {
      clear();
      return;
    }

    setSearching(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void fetchPage(normalizedQuery, null, requestId);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [fetchPage, normalizedQuery]);

  const results = page?.query === normalizedQuery ? page : null;

  const loadMore = async () => {
    const cursor = results?.nextCursor;
    if (!cursor || searching) return;
    const requestId = ++requestRef.current;
    setSearching(true);
    setError(null);
    await fetchPage(normalizedQuery, cursor, requestId);
  };

  return {
    query,
    setQuery,
    /** 검색 모드인지. 검색어가 공백뿐이면 트리를 그린다. */
    active: Boolean(normalizedQuery),
    /** 지금 검색어의 결과일 때만 값이 있다. 앞 검색어의 결과는 여기서 걸러진다. */
    results,
    searching,
    /** 아직 아무 결과도 못 받은 첫 쪽 대기. 앞 검색어의 결과가 남아 있으면 켜지 않는다. */
    firstPageLoading: searching && !page,
    error,
    loadMore,
  };
}

/**
 * 트리 한 층을 그리는 동안 층마다 달라지지 않는 값. 재귀가 층을 내려갈 때마다 일곱 칸을
 * 손으로 다시 나열했고, 칸이 하나 늘면 서명·호출부·재귀 세 자리를 함께 고쳐야 했다.
 * 층마다 다른 것은 부모 경로와 깊이뿐이라 그 둘만 칸으로 남긴다.
 */
interface DocumentTreeView {
  cache: DocumentTreeCache;
  expanded: ReadonlySet<string>;
  loadingParents: ReadonlySet<string>;
  selectedPath: string | null;
  onSelect: (entry: DocumentEntry) => void;
  onToggle: (entry: DocumentEntry) => void;
  onLoadMore: (parentPath: string, cursor: string) => void;
}

function DocumentTreeRows({
  view,
  parentPath,
  depth = 0,
}: {
  view: DocumentTreeView;
  parentPath: string;
  depth?: number;
}) {
  const { cache, expanded, loadingParents, selectedPath, onSelect, onToggle, onLoadMore } = view;
  const page = cache.get(parentPath);
  if (!page) return null;

  return <div className="document-tree-level">{page.entries.map((entry) => {
    const open = entry.isDirectory && expanded.has(entry.relativePath);
    const childPage = entry.isDirectory ? cache.get(entry.relativePath) : null;
    return <div className="document-tree-item" key={entry.relativePath}>
      <button
        className={selectedPath === entry.relativePath ? "tree-row file active" : `tree-row ${entry.isDirectory ? "directory" : "file"}`}
        style={{ paddingLeft: `${depth * 13 + 8}px` }}
        type="button"
        onClick={() => entry.isDirectory ? onToggle(entry) : onSelect(entry)}
        aria-expanded={entry.isDirectory ? open : undefined}
      >
        {entry.isDirectory
          ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          : <span className="document-tree-file-indent" aria-hidden="true" />}
        <DocumentEntryIcon entry={entry} />
        <strong>{entry.name}</strong>
      </button>
      {open && (
        <div className="document-tree-children">
          {loadingParents.has(entry.relativePath) && !childPage ? <LoadingState label={`${entry.name} 읽는 중`} /> : null}
          {childPage?.loaded && childPage.entries.length === 0 ? <p className="tree-empty">빈 폴더</p> : null}
          <DocumentTreeRows view={view} parentPath={entry.relativePath} depth={depth + 1} />
        </div>
      )}
    </div>;
  })}{page.nextCursor && (
    <button
      className="button document-tree-more"
      type="button"
      disabled={loadingParents.has(parentPath)}
      onClick={() => onLoadMore(parentPath, page.nextCursor!)}
    >
      {loadingParents.has(parentPath) ? "불러오는 중…" : `더 보기 (${page.entries.length}/${page.total})`}
    </button>
  )}</div>;
}

/**
 * Set 상태에서 한 항목만 넣거나 뺀 새 Set. 폴더 펼침과 폴더별 진행 표시를 다루는 세 자리가
 * 복사·추가·삭제를 각자 나열했고, 그 중 한 자리는 넣기만 `new Set(current).add(...)`로 줄여
 * 같은 일이 두 모양으로 남아 있었다.
 */
function withSetMember(current: ReadonlySet<string>, key: string, present: boolean): ReadonlySet<string> {
  const next = new Set(current);
  if (present) next.add(key);
  else next.delete(key);
  return next;
}

function DocumentEntryIcon({ entry }: { entry: DocumentEntry }) {
  if (entry.isDirectory) return <Folder size={14} aria-hidden="true" />;
  if (entry.previewKind === "markdown") return <FileText size={14} aria-hidden="true" />;
  if (entry.previewKind === "text") return <FileCode2 size={14} aria-hidden="true" />;
  if (entry.previewKind === "tooLarge") return <FileWarning size={14} aria-hidden="true" />;
  return <File size={14} aria-hidden="true" />;
}
