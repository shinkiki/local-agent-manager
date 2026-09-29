import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { useI18n } from "../lib/i18n";

const PAGE_SIZE = 200;
const SEARCH_DELAY_MS = 180;

/**
 * 트리 창이 읽는 곳. 창 자체는 어느 폴더를 그리는지 모른다 — 문서 화면은 등록 폴더 id로
 * 목록·검색을 부르고, 프로젝트 화면은 프로젝트 경로로 목록만 부른다. 두 화면이 같은 창을
 * 쓰려면 창이 IPC 이름이 아니라 "부모 경로와 커서를 주면 한 쪽을 돌려주는 함수"만 알면 된다.
 *
 * `key`는 "다른 곳을 보기 시작했다"의 유일한 신호다. 훅은 함수 신원이 아니라 이 값에만
 * 의존하므로, 부르는 쪽이 렌더마다 새 객체를 만들어도 트리가 매번 초기화되지 않는다.
 * `search`가 없으면 검색 상자는 그려지지 않는다.
 */
export interface DocumentTreeSource {
  key: string;
  list: (parentPath: string, cursor: string | null, pageSize: number) => Promise<DocumentEntryPage>;
  search?: (query: string, cursor: string | null, pageSize: number) => Promise<DocumentEntryPage>;
  /** 창의 접근성 이름. 화면마다 무엇의 파일인지가 다르다. */
  label: string;
}

/** 문서 화면의 등록 폴더를 읽는 원천. 예전에 트리 창이 직접 부르던 두 IPC를 그대로 감싼다. */
export function docRootTreeSource(rootId: string, label: string): DocumentTreeSource {
  return {
    key: rootId,
    list: (parentPath, cursor, pageSize) => listDocumentEntries(rootId, parentPath, cursor, pageSize),
    search: (query, cursor, pageSize) => searchDocumentEntries(rootId, query, cursor, pageSize),
    label,
  };
}

export interface DocumentTreePaneProps {
  source: DocumentTreeSource;
  selectedPath: string | null;
  onSelect: (entry: DocumentEntry) => void;
}

interface SearchPageState extends DocumentEntryPage {
  query: string;
}

export function DocumentTreePane({ source, selectedPath, onSelect }: DocumentTreePaneProps) {
  // 원천은 ref로 붙든다. 부르는 쪽이 렌더마다 새 객체를 만들어도 훅은 `source.key`에만
  // 반응하고, 실제 호출은 언제나 가장 최근에 받은 함수로 나간다.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  // 훅 호출 순서는 트리가 먼저여야 한다 — 검색 초기화가 트리 초기화보다 먼저 돌면 폴더를
  // 바꾼 첫 배치에서 트리와 검색의 갱신 순서가 예전과 어긋난다.
  const tree = useDocumentEntryTree(sourceRef, source.key, selectedPath, onSelect);
  const search = useDocumentEntrySearch(sourceRef, source.key);
  // 이 창은 등록 폴더를 고른 뒤에만 그려져 앞선 두 문서 화면 번역(AM-79·AM-213)의
  // 재현 경로 밖에 있었고, 그래서 영어 UI에서 통째로 한국어로 남아 있었다(QA #86).
  const { text } = useI18n();

  const searchLabel = text("파일명 또는 경로 검색", "Search by file name or path");

  return (
    <section className="document-tree-pane" aria-label={source.label}>
      {source.search ? (
        <label className="document-tree-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
          />
        </label>
      ) : null}
      {search.active ? (
        <DocumentSearchResults search={search} selectedPath={selectedPath} onActivate={tree.activateEntry} />
      ) : (
        <DocumentTreeScroll tree={tree} />
      )}
    </section>
  );
}

/**
 * 검색 결과 목록. 트리 쪽은 이미 컴포넌트 한 벌(`DocumentTreeScroll`)로 서 있는데 검색 쪽만
 * 창 본문에 펼쳐져 있어, 한 갈래를 고치려면 나머지 갈래의 마크업을 함께 읽어야 했다. 두
 * 갈래를 같은 높이로 맞춰 창 본문은 검색어 입력과 갈래 선택만 남긴다.
 *
 * 검색 상태는 훅이 돌려주는 한 벌을 그대로 받는다 — 이 목록이 보는 여섯 칸을 따로 풀어
 * 받으면 훅에 칸이 하나 늘 때마다 서명·호출부를 함께 고쳐야 한다.
 */
function DocumentSearchResults({
  search,
  selectedPath,
  onActivate,
}: {
  search: DocumentEntrySearch;
  selectedPath: string | null;
  onActivate: (entry: DocumentEntry) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="document-search-results" aria-live="polite">
      {search.error && <ErrorBanner message={search.error} />}
      {search.firstPageLoading ? <LoadingState label={text("파일을 검색하고 있습니다", "Searching files")} /> : null}
      {search.results?.entries.map((entry) => (
        <button
          className={selectedPath === entry.relativePath ? "document-search-row active" : "document-search-row"}
          type="button"
          key={entry.relativePath}
          onClick={() => onActivate(entry)}
        >
          <DocumentEntryIcon entry={entry} />
          <span><strong>{entry.name}</strong><code>{entry.relativePath}</code></span>
        </button>
      ))}
      {!search.searching && search.results?.entries.length === 0
        ? <p className="tree-empty">{text("조건에 맞는 파일이 없습니다.", "No files match your search.")}</p>
        : null}
      {search.results?.nextCursor && <DocumentMoreButton
        label={text("검색 결과 더 보기", "Show more results")}
        loading={search.searching}
        loaded={search.results.entries.length}
        total={search.results.total}
        onClick={() => void search.loadMore()}
      />}
    </div>
  );
}

/**
 * 트리 목록. 첫 쪽을 기다리는 동안·빈 폴더일 때 대신 보여 줄 안내가 재귀 줄 그리기와 한
 * 자리에 섞이지 않도록, 층을 그리는 `DocumentTreeRows` 바깥을 감싸는 껍데기만 맡는다.
 * 첫 쪽의 진행 표시는 루트 쪽이 아직 없을 때만 뜨던 예전 조건 그대로다.
 */
function DocumentTreeScroll({ tree }: { tree: DocumentEntryTree }) {
  const { text } = useI18n();
  return (
    <div className="document-tree-scroll">
      {tree.error && <ErrorBanner message={tree.error} />}
      {!tree.rootLoaded && tree.view.loadingParents.has("") ? <LoadingState label={text("파일 목록을 읽고 있습니다", "Loading files")} /> : null}
      {tree.rootEmpty ? <p className="tree-empty">{text("표시할 파일이 없습니다.", "No files to show.")}</p> : null}
      <DocumentTreeRows view={tree.view} parentPath="" />
    </div>
  );
}

/** 트리 목록이 받는 한 벌. 훅이 돌려주는 모양을 그대로 따른다. */
type DocumentEntryTree = ReturnType<typeof useDocumentEntryTree>;

/**
 * 폴더 트리 한 벌. 같은 창의 파일 검색은 이미 훅(`useDocumentEntrySearch`)으로 서 있는데
 * 트리 쪽만 창 본문에 펼쳐져 있어, 캐시·펼침 집합·폴더별 진행 표시·오류·요청번호 다섯
 * 상태와 쪽 읽기·폴더 전환 초기화가 검색어 입력·갈래 선택과 한자리에 섞였다. 두 갈래를
 * 같은 높이로 맞춰 창 본문은 검색어 입력과 갈래 선택만 남긴다.
 *
 * 돌려주는 `view`는 재귀 줄 그리기가 층마다 그대로 받는 묶음이다. 그 묶음을 훅 안에서
 * 조립해, 상태 칸이 하나 늘어도 창 본문의 렌더가 함께 바뀌지 않는다.
 */
function useDocumentEntryTree(
  sourceRef: RefObject<DocumentTreeSource>,
  sourceKey: string,
  selectedPath: string | null,
  onSelect: (entry: DocumentEntry) => void,
) {
  const [cache, setCache] = useState<DocumentTreeCache>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingParents, setLoadingParents] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const generation = useRequestGeneration();

  const fetchFolder = useCallback(async (
    parentPath: string,
    cursor: string | null,
    requestId: number,
  ) => {
    setLoadingParents((current) => withSetMember(current, parentPath, true));
    setError(null);
    await generation.latest(
      requestId,
      () => sourceRef.current.list(parentPath, cursor, PAGE_SIZE),
      {
        onResult: (page) => setCache((current) => mergeDocumentEntryPage(current, parentPath, page, cursor !== null)),
        onError: setError,
        onSettled: () => setLoadingParents((current) => withSetMember(current, parentPath, false)),
      },
    );
    // `sourceKey`는 값으로는 쓰이지 않지만, 원천이 바뀌면 이 함수도 새로 서야 아래 초기화
    // 효과가 다시 돈다. ref의 함수는 그 시점의 최신 원천을 가리킨다.
  }, [generation, sourceKey, sourceRef]);

  useEffect(() => {
    const requestId = generation.open();
    setCache(new Map());
    setExpanded(new Set());
    setLoadingParents(new Set());
    setError(null);
    void fetchFolder("", null, requestId);
  }, [fetchFolder, generation, sourceKey]);

  const toggleFolder = (entry: DocumentEntry) => {
    const willExpand = !expanded.has(entry.relativePath);
    setExpanded((current) => withSetMember(current, entry.relativePath, willExpand));
    if (willExpand && !cache.has(entry.relativePath)) {
      void fetchFolder(entry.relativePath, null, generation.current());
    }
  };

  // 항목을 누르면 폴더는 펼치고 파일은 고른다. 검색 결과 줄과 트리 줄이 같은 삼항식을
  // 각자 나열했고, 그 탓에 트리 쪽은 콜백 둘을 층마다 함께 들고 내려가야 했다.
  const activateEntry = (entry: DocumentEntry) => entry.isDirectory ? toggleFolder(entry) : onSelect(entry);

  const rootEntries = useMemo(() => documentEntriesForParent(cache, ""), [cache]);
  const rootPage = cache.get("");

  return {
    /** 검색 결과 줄도 같은 한 벌을 쓴다 — 고른 항목을 다루는 갈래는 창에 하나뿐이다. */
    activateEntry,
    error,
    /** 루트 쪽을 한 번이라도 받았는가. 첫 쪽 진행 표시는 이것이 꺼져 있을 때만 뜬다. */
    rootLoaded: Boolean(rootPage),
    rootEmpty: Boolean(rootPage) && rootEntries.length === 0,
    view: {
      cache,
      expanded,
      loadingParents,
      selectedPath,
      onActivate: activateEntry,
      onLoadMore: (parentPath: string, cursor: string) => void fetchFolder(parentPath, cursor, generation.current()),
    } satisfies DocumentTreeView,
  };
}

/** 검색 목록이 받는 한 벌. 훅이 돌려주는 모양을 그대로 따른다. */
type DocumentEntrySearch = ReturnType<typeof useDocumentEntrySearch>;

/**
 * 파일 검색 한 벌. 검색어·결과 쪽수·진행 표시·오류·요청번호가 트리 페이징 상태와 한
 * 컴포넌트에 섞여 있었고, 늦게 도착한 결과를 가리는 `searchPage.query === normalizedQuery`
 * 대조가 렌더와 더 보기에 다섯 번 흩어져 있었다. 대조를 훅 안으로 들여 `results`는 지금
 * 검색어의 결과일 때만 값을 갖게 하고, 트리 창은 그 결과를 그리는 일만 맡는다.
 *
 * 폴더가 바뀌면 검색어까지 비우는 것은 예전 동작 그대로다.
 */
function useDocumentEntrySearch(sourceRef: RefObject<DocumentTreeSource>, sourceKey: string) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<SearchPageState | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRequestGeneration();
  const normalizedQuery = query.trim();

  // 결과를 비우는 자리가 둘(폴더 전환·검색어 지움)이라 같은 세 상태를 같은 순서로 나열했다.
  // 요청번호는 부르는 자리가 이미 올려 두므로 여기서는 건드리지 않는다.
  const clear = () => {
    setPage(null);
    setError(null);
    setSearching(false);
  };

  // 입력 검색과 더 보기는 같은 세 상태 전이로 요청을 연다. 요청 세대를 먼저 올리는 순서를
  // 포함해 한곳에 두어, 어느 한 갈래만 이전 오류를 남기거나 로딩 표시를 빠뜨리지 않게 한다.
  const beginSearch = useCallback(() => {
    const requestId = generation.open();
    setSearching(true);
    setError(null);
    return requestId;
  }, [generation]);

  /**
   * 결과를 읽어 오는 두 자리(입력 디바운스·더 보기)가 공유하는 한 벌. 커서가 있을 때만
   * 앞서 받은 결과 뒤에 이어 붙이는 것이 유일한 차이다. 진행 표시를 켜는 것은 디바운스
   * 시점이 자리마다 달라 부르는 쪽에 남긴다. 늦게 온 응답을 버리는 일은 `latest`가 맡는다.
   */
  const fetchPage = useCallback(async (
    searchQuery: string,
    cursor: string | null,
    requestId: number,
  ) => {
    await generation.latest(
      requestId,
      () => {
        // 검색 상자는 `search`가 있을 때만 그려지므로 여기 닿는 원천은 검색을 안다. 그래도
        // 원천이 바뀌는 사이 늦게 온 입력은 빈 쪽으로 답해 오류 배너 대신 빈 목록을 그린다.
        const search = sourceRef.current.search;
        return search ? search(searchQuery, cursor, PAGE_SIZE) : Promise.resolve({ entries: [], nextCursor: null, total: 0 });
      },
      {
        onResult: (next) => setPage((current) => cursor && current?.query === searchQuery
          ? { ...next, query: searchQuery, entries: mergeDocumentEntries(current.entries, next.entries) }
          : { ...next, query: searchQuery }),
        onError: setError,
        onSettled: () => setSearching(false),
      },
    );
  }, [generation, sourceKey, sourceRef]);

  useEffect(() => {
    generation.open();
    setQuery("");
    clear();
  }, [generation, sourceKey]);

  useEffect(() => {
    if (!normalizedQuery) {
      generation.open();
      clear();
      return;
    }

    const requestId = beginSearch();
    const timer = window.setTimeout(() => {
      void fetchPage(normalizedQuery, null, requestId);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [beginSearch, fetchPage, generation, normalizedQuery]);

  const results = page?.query === normalizedQuery ? page : null;

  const loadMore = async () => {
    const cursor = results?.nextCursor;
    if (!cursor || searching) return;
    const requestId = beginSearch();
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
  /** 폴더는 펼치고 파일은 고른다. 검색 결과 줄과 같은 한 벌이라 갈래를 여기서 다시 나누지 않는다. */
  onActivate: (entry: DocumentEntry) => void;
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
  const { cache, loadingParents, onLoadMore } = view;
  const page = cache.get(parentPath);
  if (!page) return null;
  const nextCursor = page.nextCursor;

  return (
    <div className="document-tree-level">
      {page.entries.map((entry) => (
        <DocumentTreeItem
          key={entry.relativePath}
          entry={entry}
          view={view}
          depth={depth}
        />
      ))}
      {nextCursor && (
        <DocumentMoreButton
          label="더 보기"
          loading={loadingParents.has(parentPath)}
          loaded={page.entries.length}
          total={page.total}
          onClick={() => onLoadMore(parentPath, nextCursor)}
        />
      )}
    </div>
  );
}

/**
 * 트리 항목 한 줄과 펼쳐진 하위 폴더 영역. 한 항목의 버튼 표시(인덴트·아이콘·선택 여부)와
 * 펼쳐졌을 때의 하위 상태(로딩·빈 폴더·재귀 레벨)를 제 컴포넌트로 묶어, `DocumentTreeRows`는
 * 층별 항목 매핑과 다음 쪽 더 보기 버튼만 다루게 한다.
 */
function DocumentTreeItem({
  entry,
  view,
  depth,
}: {
  entry: DocumentEntry;
  view: DocumentTreeView;
  depth: number;
}) {
  const { cache, expanded, loadingParents, selectedPath, onActivate } = view;
  const isDir = entry.isDirectory;
  const open = isDir && expanded.has(entry.relativePath);
  const childPage = isDir ? cache.get(entry.relativePath) : null;
  const active = selectedPath === entry.relativePath;

  return (
    <div className="document-tree-item">
      <button
        className={active ? "tree-row file active" : `tree-row ${isDir ? "directory" : "file"}`}
        style={{ paddingLeft: `${depth * 13 + 8}px` }}
        type="button"
        onClick={() => onActivate(entry)}
        aria-expanded={isDir ? open : undefined}
      >
        {isDir ? (
          open ? <ChevronDown size={12} /> : <ChevronRight size={12} />
        ) : (
          <span className="document-tree-file-indent" aria-hidden="true" />
        )}
        <DocumentEntryIcon entry={entry} />
        <strong data-user-content>{entry.name}</strong>
      </button>
      {open && (
        <div className="document-tree-children">
          {loadingParents.has(entry.relativePath) && !childPage ? <LoadingState label={`${entry.name} 읽는 중`} /> : null}
          {childPage?.loaded && childPage.entries.length === 0 ? <p className="tree-empty">빈 폴더</p> : null}
          <DocumentTreeRows view={view} parentPath={entry.relativePath} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

/**
 * 다음 쪽을 부르는 버튼. 검색 결과와 트리가 같은 마크업·같은 진행 문구·같은 `읽은 수/전체
 * 수` 표기를 각자 나열했고, 실제로 다른 것은 머리말 낱말 하나뿐이었다. 그 하나만 칸으로
 * 남겨 한 벌로 모은다.
 */
function DocumentMoreButton({
  label,
  loading,
  loaded,
  total,
  onClick,
}: {
  label: string;
  loading: boolean;
  loaded: number;
  total: number;
  onClick: () => void;
}) {
  return (
    <button className="button document-tree-more" type="button" disabled={loading} onClick={onClick}>
      {loading ? "불러오는 중…" : `${label} (${loaded}/${total})`}
    </button>
  );
}

/**
 * 늦게 도착한 응답을 버리는 요청 세대 한 벌. 트리 페이징과 파일 검색이 각자 `useRef(0)`를
 * 두고 `++ref.current`로 세대를 열고 `id === ref.current`로 대조했다. 같은 규칙이 한 파일에
 * 두 벌 있어, 한쪽에서 세대를 올리는 자리를 빠뜨려도 다른 쪽을 보고는 알 수 없었다.
 *
 * 문서 화면의 문서 이동(`DocsView`의 `useDocNavigation`)도 같은 규칙을 손으로 또 한 벌
 * 적고 있었으므로 내보내 함께 쓴다. 제자리는 `src/lib`의 독립 모듈이지만, 트리 창은 이
 * 규칙을 가장 촘촘히 쓰는 자리이자 문서 화면이 이미 들여오는 파일이라 새 의존 방향을
 * 만들지 않는다.
 *
 * 세대 번호는 상태가 아니라 ref다(바뀌어도 다시 그리지 않는다). 돌려주는 묶음은 첫 렌더에
 * 한 번만 만들어 신원이 고정되므로, 이 묶음을 보는 `useCallback`·`useEffect`의 의존 목록에
 * 넣어도 매 렌더마다 다시 만들어지지 않는다.
 *
 * 세대를 `isCurrent`로 직접 대조하던 세 자리(트리 페이징·파일 검색·문서 이동)는 한 요청을
 * try/catch/finally 세 갈래에서 각자 대조했다. 대조를 세 번 적는 모양이라 한 갈래만
 * 빠뜨려도 — 실제로 문서 이동의 `catch`는 이른 `return` 대신 `if`로 감싸 두 모양이
 * 섞여 있었다 — 늦게 온 응답이 새 선택을 덮는지 여부가 자리마다 달라진다. `latest`가 그
 * 세 갈래를 한 벌로 묶어, 부르는 쪽은 최신 응답에 무엇을 할지만 적는다. 세대를 직접
 * 대조하는 창구(`isCurrent`)는 그 뒤로 아무도 쓰지 않아 계약에서 뺐다 — 남겨 두면 세
 * 갈래를 손으로 다시 적는 길이 열려 있는 셈이다.
 */
export interface RequestGeneration {
  /** 지금까지의 요청을 모두 무효로 하고 새 세대를 열어 그 번호를 돌려준다. */
  open: () => number;
  /** 지금 세대. 이미 열려 있는 세대에 얹는 후속 요청(더 보기·하위 폴더)이 쓴다. */
  current: () => number;
  /**
   * 한 요청을 끝까지 지킨다. 응답을 기다리는 동안 세대가 바뀌었으면 성공·실패·뒷정리
   * 어느 것도 하지 않는다.
   */
  latest: <T>(
    generation: number,
    work: () => Promise<T>,
    handlers: LatestRequestHandlers<T>,
  ) => Promise<void>;
}

/** `latest`가 최신 요청일 때만 부르는 세 자리. */
export interface LatestRequestHandlers<T> {
  /** 최신 응답이 도착했을 때. */
  onResult: (value: T) => void;
  /** 최신 요청이 실패했을 때. 오류 문구는 여기 닿기 전에 이미 풀어 둔다. */
  onError: (message: string) => void;
  /** 성공·실패와 무관한 뒷정리(진행 표시 끄기). 늦게 온 응답에서는 부르지 않는다. */
  onSettled?: () => void;
}

export function useRequestGeneration(): RequestGeneration {
  const generationRef = useRef(0);
  const [api] = useState<RequestGeneration>(() => {
    const isCurrent = (generation: number) => generation === generationRef.current;
    return {
      open: () => ++generationRef.current,
      current: () => generationRef.current,
      latest: async <T,>(
        generation: number,
        work: () => Promise<T>,
        { onResult, onError, onSettled }: LatestRequestHandlers<T>,
      ) => {
        try {
          const value = await work();
          if (isCurrent(generation)) onResult(value);
        } catch (cause) {
          if (isCurrent(generation)) onError(errorText(cause));
        } finally {
          if (isCurrent(generation)) onSettled?.();
        }
      },
    };
  });
  return api;
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
