import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, PanelLeftClose, PanelLeftOpen, Plus, TriangleAlert, X } from "lucide-react";
import {
  createDocRoot,
  deleteDocRoot,
  downloadDocumentFile,
  downloadDocLinkedFile,
  getDocumentFile,
  getDocLinkedFile,
  getDocRoots,
  putDoc,
} from "../lib/ipc";
import type { AccountSnapshot, DocRootStatus, DocumentEntry, DocumentFile, ModelOption, ProviderStatus } from "../types";
import { EmptyState, ErrorBanner, LoadingState, useEscapeToClose } from "./Shared";
import { useI18n } from "../lib/i18n";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { missingDirectoryPath, missingDirectoryPrompt } from "../lib/missingDirectory";
import { readSecondaryPaneOpen, writeSecondaryPaneOpen } from "../lib/secondaryPane";
import { DocumentTreePane } from "./DocumentTreePane";
import { DocumentFilePane } from "./DocumentFilePane";
import { DocumentAutomationPanel } from "./DocumentAutomationPanel";
import { errorText } from "../lib/errorText";

const DOC_HISTORY_LIMIT = 100;
const DOC_SIDEBAR_OPEN_KEY = "agent-manager.docs-sidebar";

interface DocHistoryEntry {
  rootId: string;
  relativePath: string;
  scrollTop: number;
}

interface DocHistoryState {
  entries: DocHistoryEntry[];
  index: number;
}

export interface DocsViewProps {
  /** 변경 자동화의 채팅·스킬 액션이 공급자와 실행 계정을 고르는 데 쓴다. */
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  models: ModelOption[];
  onRequestAiaPrompt?: (prompt: string) => void;
}

export function DocsView({ providers, accounts, models, onRequestAiaPrompt }: DocsViewProps) {
  // 섹션 탭 문구와 nav aria-label은 정적 UI 치환기가 속성까지 닿지 않으므로 컴포넌트가 직접 text()로 고른다.
  const { text } = useI18n();
  const [section, setSection] = useState<"files" | "automation">("files");
  const [roots, setRoots] = useState<DocRootStatus[] | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<DocRootStatus | null>(null);
  const [doc, setDoc] = useState<DocumentFile | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRootForm, setShowRootForm] = useState(false);
  const [rootName, setRootName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [newDocPath, setNewDocPath] = useState("");
  const [treeRevision, setTreeRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => readSecondaryPaneOpen(DOC_SIDEBAR_OPEN_KEY));
  const [sidebarIsOverlay, setSidebarIsOverlay] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const workspaceRef = useRef<HTMLElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarRestoreRef = useRef<HTMLButtonElement>(null);
  const sidebarFocusTargetRef = useRef<"close" | "restore" | null>(null);
  const navigationRequestRef = useRef(0);

  const selectedRootId = selectedRoot?.id ?? null;
  const currentDocPath = doc?.relativePath ?? null;
  const loadLinkedFile = useCallback((href: string) => {
    if (!selectedRootId || !currentDocPath) {
      return Promise.reject(new Error("문서를 선택하세요."));
    }
    return getDocLinkedFile(selectedRootId, currentDocPath, href);
  }, [currentDocPath, selectedRootId]);
  const downloadLinkedFile = useCallback((href: string) => {
    if (!selectedRootId || !currentDocPath) {
      return Promise.reject(new Error("문서를 선택하세요."));
    }
    return downloadDocLinkedFile(selectedRootId, currentDocPath, href);
  }, [currentDocPath, selectedRootId]);
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);

  const setSidebarVisibility = (open: boolean) => {
    sidebarFocusTargetRef.current = open ? "close" : "restore";
    setSidebarOpen(open);
  };

  // 문서를 화면에 올리는 세 자리(이동·생성·저장)가 같은 네 상태를 같은 순서로 갱신했다.
  // 편집 여부는 자리마다 달라(이동은 읽기, 생성은 편집, 저장은 그대로) 인자로만 받고,
  // 넘기지 않으면 저장처럼 편집 상태를 건드리지 않는다.
  const showDocument = (file: DocumentFile, nextEditing?: boolean) => {
    setDoc(file);
    setDraft(file.content ?? "");
    setDirty(false);
    if (nextEditing !== undefined) setEditing(nextEditing);
  };

  // 진행 중인 이동 응답을 버리는 표시. 폴더를 바꾸거나 해제할 때 늦게 도착한 문서가
  // 새 선택을 덮어쓰지 않게 한다.
  const cancelNavigation = () => {
    navigationRequestRef.current += 1;
    setNavigating(false);
  };

  // 저장하지 않은 초안이 있을 때 되묻는 자리가 넷(문서 이동·폴더 전환·새 문서·기록 이동)이라
  // 조건과 문구 조립이 그만큼 흩어져 있었다. 물음의 뒷말만 자리마다 다르다.
  const confirmDiscardDraft = (question: string) => !dirty || window.confirm(`저장하지 않은 변경이 있습니다. ${question}`);

  // 저장·새 문서·내려받기가 같은 순서(진행 표시 켜기 → 오류 지우기 → 실패 시 오류 표시 →
  // 진행 표시 끄기)를 되풀이했다. 진행 표시만 자리마다 다르므로 setter를 인자로 받는다.
  const runBusy = async (setBusy: (value: boolean) => void, work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => writeSecondaryPaneOpen(DOC_SIDEBAR_OPEN_KEY, sidebarOpen), [sidebarOpen]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setSidebarIsOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useLayoutEffect(() => {
    const target = sidebarFocusTargetRef.current;
    if (!target) return;
    sidebarFocusTargetRef.current = null;
    if (target === "close") sidebarCloseRef.current?.focus();
    else sidebarRestoreRef.current?.focus();
  }, [sidebarOpen]);
  useEscapeToClose(() => setSidebarVisibility(false), sidebarOpen && sidebarIsOverlay);

  // 기록을 다루는 자리가 여섯(이동·되돌아가기·생성·폴더 전환·폴더 해제·화살표 버튼)이라
  // 상태·ref·복원 대기 값이 화면 상태와 뒤섞여 있었다. 훅 호출은 사이드바 포커스 효과보다
  // 뒤에 두어야 한다 — 스크롤 복원이 먼저 돌면 뒤이은 포커스가 그 자리를 다시 끌어올린다.
  const history = useDocHistory(workspaceRef, doc);

  const loadRoots = useCallback(async () => {
    try {
      const next = await getDocRoots();
      setRoots(next);
      setSelectedRoot((current) => next.find((root) => root.id === current?.id) ?? next[0] ?? null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => { void loadRoots(); }, [loadRoots]);

  const navigateToDocument = async (
    rootId: string,
    relativePath: string,
    historyIndex: number | null = null,
  ) => {
    if (historyIndex === null && doc?.rootId === rootId && doc.relativePath === relativePath) return;
    if (!confirmDiscardDraft("이동할까요?")) return;
    const targetRoot = roots?.find((root) => root.id === rootId);
    if (!targetRoot) {
      setError("문서 폴더를 찾을 수 없습니다.");
      return;
    }

    const historyBeforeNavigation = history.captureScroll();
    if (historyIndex !== null && !history.pointsAt(historyBeforeNavigation, historyIndex, rootId, relativePath)) return;

    const requestId = ++navigationRequestRef.current;
    setNavigating(true);
    setError(null);
    try {
      const file = await getDocumentFile(rootId, relativePath);
      if (requestId !== navigationRequestRef.current) return;
      history.land(historyBeforeNavigation, rootId, relativePath, historyIndex);
      setSelectedRoot(targetRoot);
      showDocument(file, false);
      if (sidebarIsOverlay) setSidebarVisibility(false);
    } catch (cause) {
      if (requestId === navigationRequestRef.current) {
        setError(errorText(cause));
      }
    } finally {
      if (requestId === navigationRequestRef.current) setNavigating(false);
    }
  };

  const selectFile = (entry: DocumentEntry) => {
    if (!selectedRoot) return;
    const relativePath = entry.relativePath;
    if (sidebarIsOverlay && doc?.rootId === selectedRoot.id && doc.relativePath === relativePath) {
      setSidebarVisibility(false);
      return;
    }
    void navigateToDocument(selectedRoot.id, relativePath);
  };

  const moveHistory = (offset: -1 | 1) => {
    const target = history.step(offset);
    if (!target) return;
    void navigateToDocument(target.entry.rootId, target.entry.relativePath, target.index);
  };

  const selectRoot = (root: DocRootStatus) => {
    if (selectedRoot?.id === root.id) return;
    if (!confirmDiscardDraft("이동할까요?")) return;
    history.captureScroll();
    cancelNavigation();
    linkedFilePreview.close();
    setSelectedRoot(root);
    setDoc(null);
    setDraft("");
    setDirty(false);
    setEditing(false);
  };

  const submitRoot = async (path: string, createIfMissing = false) => {
    const root = await createDocRoot(rootName, path, createIfMissing);
    setRootName("");
    setRootPath("");
    setShowRootForm(false);
    await loadRoots();
    setSelectedRoot(root);
  };

  // 아직 만들지 않은 폴더를 문서 폴더로 등록하려는 것은 오타만큼이나 흔하다. 없는 경로일
  // 때만 만들지 물어보고, 승인하면 등록이 그 한 칸을 함께 만들도록 다시 시도한다. 폴더를
  // 따로 만들지 않고 등록 안에서 만드는 이유는 원격 화면 때문이다 — `create_directory`는
  // 호스트 전용이라 원격에서는 승인해도 거절됐다.
  const addRoot = async () => {
    setError(null);
    try {
      await submitRoot(rootPath);
    } catch (cause) {
      const missing = missingDirectoryPath(errorText(cause));
      if (!missing || !window.confirm(missingDirectoryPrompt(missing))) {
        setError(errorText(cause));
        return;
      }
      try {
        await submitRoot(missing, true);
      } catch (retryCause) {
        setError(errorText(retryCause));
      }
    }
  };

  const removeRoot = async (root: DocRootStatus) => {
    if (!window.confirm(`'${root.name}' 등록을 해제할까요? 원본 폴더와 파일은 삭제되지 않습니다.`)) return;
    try {
      await deleteDocRoot(root.id);
      history.dropRoot(root.id);
      if (selectedRoot?.id === root.id) {
        cancelNavigation();
        setSelectedRoot(null);
        setDoc(null);
      }
      await loadRoots();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const createFile = async () => {
    if (!selectedRoot || !newDocPath.trim()) return;
    if (!confirmDiscardDraft("새 문서를 만들까요?")) return;
    const historyBeforeNavigation = history.captureScroll();
    await runBusy(setSaving, async () => {
      const path = newDocPath.trim().toLowerCase().endsWith(".md") ? newDocPath.trim() : `${newDocPath.trim()}.md`;
      const created = await putDoc(selectedRoot.id, path, "# 새 문서\n", null);
      const file = await getDocumentFile(created.rootId, created.relativePath);
      history.land(historyBeforeNavigation, file.rootId, file.relativePath);
      showDocument(file, true);
      setNewDocPath("");
      if (sidebarIsOverlay) setSidebarVisibility(false);
      setTreeRevision((current) => current + 1);
    });
  };

  const save = async () => {
    if (!doc) return;
    await runBusy(setSaving, async () => {
      await putDoc(doc.rootId, doc.relativePath, draft, doc.modifiedAt);
      const file = await getDocumentFile(doc.rootId, doc.relativePath);
      showDocument(file);
      setTreeRevision((current) => current + 1);
    });
  };

  const downloadCurrentDoc = async () => {
    if (!doc || downloading) return;
    await runBusy(setDownloading, () => downloadDocumentFile(doc.rootId, doc.relativePath));
  };

  const openLinkedDoc = (href: string) => {
    if (!doc || !selectedRoot) return;
    if (isMarkdownLink(href)) {
      const relativePath = resolveDocLink(selectedRoot.path, doc.relativePath, href);
      if (!relativePath) {
        setError("문서 폴더 밖의 Markdown 링크는 열 수 없습니다.");
        return;
      }
      void navigateToDocument(doc.rootId, relativePath);
      return;
    }
    linkedFilePreview.open(href);
  };

  // 문서 폴더를 되살리는 버튼은 빈 화면 머리말과 문서 머리말 두 자리에 같은 모양·같은
  // ref로 놓인다. 두 자리는 배타적으로 렌더되므로 ref가 겹치지 않는다.
  const sidebarRestoreButton = (
    <button
      ref={sidebarRestoreRef}
      className="icon-button secondary-pane-toggle"
      type="button"
      data-ui-anchor="docs.sidebar"
      onClick={() => setSidebarVisibility(true)}
      aria-label="문서 폴더 보기"
      title="문서 폴더 보기"
      aria-expanded={false}
    ><PanelLeftOpen size={16} /></button>
  );

  return (
    <div className="docs-layout">
      {sidebarOpen && <DocsSidebar
        roots={roots}
        selectedRoot={selectedRoot}
        doc={doc}
        treeRevision={treeRevision}
        saving={saving}
        navigating={navigating}
        closeRef={sidebarCloseRef}
        onClose={() => setSidebarVisibility(false)}
        onSelectRoot={selectRoot}
        onRemoveRoot={removeRoot}
        onAddRoot={addRoot}
        rootName={rootName}
        rootPath={rootPath}
        onRootNameChange={setRootName}
        onRootPathChange={setRootPath}
        showRootForm={showRootForm}
        onToggleRootForm={() => setShowRootForm((value) => !value)}
        newDocPath={newDocPath}
        onNewDocPathChange={setNewDocPath}
        onCreateFile={createFile}
        onSelectFile={selectFile}
      />}
      {sidebarOpen && sidebarIsOverlay && <button className="docs-sidebar-backdrop" type="button" onClick={() => setSidebarVisibility(false)} aria-label="문서 폴더 닫기" />}
      <main className="doc-workspace" ref={workspaceRef}>
        <nav className="docs-section-tabs" aria-label={text("문서 메뉴", "Document menu")}><button className={section === "files" ? "active" : ""} type="button" onClick={() => setSection("files")}>{text("파일", "Files")}</button><button className={section === "automation" ? "active" : ""} type="button" onClick={() => setSection("automation")}>{text("변경 자동화", "Change automation")}</button></nav>
        {section === "automation" ? <DocumentAutomationPanel roots={roots ?? []} providers={providers} accounts={accounts} models={models} onRequestAiaPrompt={onRequestAiaPrompt} /> : <>
        {error && <ErrorBanner message={error} />}
        {!sidebarOpen && !doc && <header className="doc-header doc-header-empty">{sidebarRestoreButton}</header>}
        {!doc ? <EmptyState title="파일을 선택하세요" detail="일반 파일을 탐색하고 Markdown과 UTF-8 텍스트를 미리볼 수 있습니다." /> : <DocumentFilePane
          file={doc}
          draft={draft}
          editing={editing}
          dirty={dirty}
          saving={saving}
          downloading={downloading}
          headerLeading={!sidebarOpen ? sidebarRestoreButton : null}
          onEditingChange={setEditing}
          onDraftChange={(value) => { setDraft(value); setDirty(value !== (doc.content ?? "")); }}
          onSave={save}
          onDownload={downloadCurrentDoc}
          onOpenLocalLink={openLinkedDoc}
        />}
        </>}
      </main>
      {doc && section === "files" && <nav className="doc-history-nav" aria-label={text("문서 이동 기록", "Document history")}>
        <button type="button" onClick={() => moveHistory(-1)} disabled={navigating || history.state.index <= 0} aria-label={text("이전 문서", "Previous document")} title={text("이전 문서", "Previous document")}><ArrowLeft size={17} /></button>
        <button type="button" onClick={() => moveHistory(1)} disabled={navigating || history.state.index >= history.state.entries.length - 1} aria-label={text("다음 문서", "Next document")} title={text("다음 문서", "Next document")}><ArrowRight size={17} /></button>
      </nav>}
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </div>
  );
}

/**
 * 문서 폴더 사이드바. 폴더 목록·등록 폼·문서 트리는 화면 본문(문서 읽기·편집·이동 기록)과
 * 상태를 나눠 갖지 않고 콜백으로만 이어지므로, 표시 전용 컴포넌트로 떼어 DocsView의 렌더가
 * 문서 작업대만 다루게 한다.
 */
function DocsSidebar({
  roots,
  selectedRoot,
  doc,
  treeRevision,
  saving,
  navigating,
  closeRef,
  onClose,
  onSelectRoot,
  onRemoveRoot,
  onAddRoot,
  rootName,
  rootPath,
  onRootNameChange,
  onRootPathChange,
  showRootForm,
  onToggleRootForm,
  newDocPath,
  onNewDocPathChange,
  onCreateFile,
  onSelectFile,
}: {
  roots: DocRootStatus[] | null;
  selectedRoot: DocRootStatus | null;
  doc: DocumentFile | null;
  treeRevision: number;
  saving: boolean;
  navigating: boolean;
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelectRoot: (root: DocRootStatus) => void;
  onRemoveRoot: (root: DocRootStatus) => void;
  onAddRoot: () => void;
  rootName: string;
  rootPath: string;
  onRootNameChange: (value: string) => void;
  onRootPathChange: (value: string) => void;
  showRootForm: boolean;
  onToggleRootForm: () => void;
  newDocPath: string;
  onNewDocPathChange: (value: string) => void;
  onCreateFile: () => void;
  onSelectFile: (entry: DocumentEntry) => void;
}) {
  return (
    <aside className="docs-sidebar" id="docs-sidebar" data-ui-anchor="docs.sidebar">
      <div className="docs-sidebar-head"><div><strong>문서 폴더</strong><span>{roots?.length ?? 0}개</span></div><div className="secondary-pane-header-actions"><button className="icon-button" type="button" onClick={onToggleRootForm} aria-label="문서 폴더 추가" aria-expanded={showRootForm}><Plus size={16} /></button><button ref={closeRef} className="icon-button secondary-pane-toggle" type="button" onClick={onClose} aria-label="문서 폴더 숨기기" title="문서 폴더 숨기기"><PanelLeftClose size={16} /></button></div></div>
      {showRootForm && <div className="root-form"><input value={rootName} onChange={(event) => onRootNameChange(event.target.value)} placeholder="표시 이름 (선택)" /><input value={rootPath} onChange={(event) => onRootPathChange(event.target.value)} placeholder="/Users/me/Documents/notes" /><button className="button primary" type="button" disabled={!rootPath.trim()} onClick={onAddRoot}>폴더 등록</button></div>}
      {roots === null ? <LoadingState label="문서 폴더 확인 중" /> : roots.length === 0 ? <EmptyState title="등록된 폴더 없음" detail="상단 + 버튼에서 로컬 문서 폴더를 등록하세요." /> : (
        <div className="root-list">{roots.map((root) => <div className={selectedRoot?.id === root.id ? "root-row active" : "root-row"} key={root.id}><button type="button" onClick={() => onSelectRoot(root)}>{root.exists ? <ChevronDown size={13} /> : <TriangleAlert size={13} />}<span><strong>{root.name}</strong><code>{root.path}</code></span></button><button className="remove-root" type="button" onClick={() => onRemoveRoot(root)} aria-label="폴더 제거"><X size={13} /></button></div>)}</div>
      )}
      {selectedRoot && <div className="doc-tree-panel">
        <div className="new-doc-row"><input value={newDocPath} onChange={(event) => onNewDocPathChange(event.target.value)} onKeyDown={(event) => event.key === "Enter" && !navigating && onCreateFile()} placeholder="새 문서 경로.md" /><button type="button" disabled={saving || navigating || !newDocPath.trim()} onClick={onCreateFile} aria-label="새 문서 만들기"><Plus size={14} /></button></div>
        {selectedRoot.exists && !selectedRoot.restricted
          ? <DocumentTreePane key={`${selectedRoot.id}:${treeRevision}`} rootId={selectedRoot.id} selectedPath={doc?.relativePath ?? null} onSelect={onSelectFile} />
          : <p className="tree-empty">접근할 수 없는 폴더입니다.</p>}
      </div>}
    </aside>
  );
}

/**
 * 문서 이동 기록. 항목 목록과 현재 위치, 되돌아갈 때 복원할 스크롤 위치를 함께 다룬다.
 * 갱신 직후 같은 턴에서 최신 기록을 다시 읽는 자리(연속 이동·폴더 해제)가 있어 상태와
 * ref를 나란히 들고, 둘을 한 번에 바꾸는 `commit`만 안에서 쓴다. 스크롤 복원은 문서가
 * 바뀐 뒤 배치(layout) 단계에서 한 번만 일어나야 하므로 이 훅이 함께 들고 있다.
 */
function useDocHistory(workspaceRef: RefObject<HTMLElement | null>, doc: DocumentFile | null) {
  const [state, setState] = useState<DocHistoryState>({ entries: [], index: -1 });
  const stateRef = useRef<DocHistoryState>({ entries: [], index: -1 });
  const pendingScrollTopRef = useRef<number | null>(null);

  const commit = (next: DocHistoryState) => {
    stateRef.current = next;
    setState(next);
  };

  /**
   * 지금 보고 있는 문서의 스크롤 위치를 기록에 반영하고 그 결과를 돌려준다. 호출부는
   * 반환값을 이동이 끝날 때까지 들고 있다가 `land`에 넘겨, 비동기로 문서를 읽어 오는
   * 사이에 다른 갱신이 끼어들어도 같은 기준에서 이어 쌓게 한다.
   */
  const captureScroll = (): DocHistoryState => {
    const current = stateRef.current;
    const entry = current.entries[current.index];
    if (!doc || !entry || entry.rootId !== doc.rootId || entry.relativePath !== doc.relativePath) {
      return current;
    }
    const scrollTop = workspaceRef.current?.scrollTop ?? entry.scrollTop;
    if (scrollTop === entry.scrollTop) return current;
    const entries = [...current.entries];
    entries[current.index] = { ...entry, scrollTop };
    const next = { entries, index: current.index };
    commit(next);
    return next;
  };

  /** 기록으로 되돌아가는 요청이 지금도 그 자리를 가리키는지. 어긋나면 이동을 시작하지 않는다. */
  const pointsAt = (base: DocHistoryState, index: number, rootId: string, relativePath: string): boolean => {
    const entry = base.entries[index];
    return Boolean(entry && entry.rootId === rootId && entry.relativePath === relativePath);
  };

  /**
   * 문서를 화면에 올리면서 기록을 확정한다. 기록 이동이면 그 자리로 옮기고 저장해 둔
   * 스크롤을, 새 이동·생성이면 항목을 쌓고 맨 위를 복원 대상으로 남긴다.
   */
  const land = (base: DocHistoryState, rootId: string, relativePath: string, historyIndex: number | null = null) => {
    const entry = historyIndex === null ? null : base.entries[historyIndex];
    if (historyIndex !== null && entry) {
      commit({ entries: base.entries, index: historyIndex });
      pendingScrollTopRef.current = entry.scrollTop;
      return;
    }
    commit(pushHistoryEntry(base, rootId, relativePath));
    pendingScrollTopRef.current = 0;
  };

  /** 기록에서 offset만큼 떨어진 자리. 양 끝을 넘어서면 null이다. */
  const step = (offset: -1 | 1): { index: number; entry: DocHistoryEntry } | null => {
    const index = stateRef.current.index + offset;
    const entry = stateRef.current.entries[index];
    return entry ? { index, entry } : null;
  };

  /** 등록이 풀린 폴더의 항목을 걷어낸다. 현재 위치는 남은 항목 기준으로 다시 센다. */
  const dropRoot = (rootId: string) => {
    const current = stateRef.current;
    const entries = current.entries.filter((entry) => entry.rootId !== rootId);
    const index = current.entries
      .slice(0, current.index + 1)
      .filter((entry) => entry.rootId !== rootId).length - 1;
    commit({ entries, index: Math.min(index, entries.length - 1) });
  };

  useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    if (scrollTop === null) return;
    pendingScrollTopRef.current = null;
    workspaceRef.current?.scrollTo({ top: scrollTop, behavior: "auto" });
  }, [doc?.relativePath, doc?.rootId]);

  return { state, captureScroll, pointsAt, land, step, dropRoot };
}

// 이동 기록은 현재 위치 뒤를 잘라내고 새 항목을 쌓는다. 같은 문서를 다시 열었을 때는
// 항목을 늘리지 않고 스크롤만 맨 위로 되돌리고, 기록은 최근 DOC_HISTORY_LIMIT개만 남긴다.
function pushHistoryEntry(base: DocHistoryState, rootId: string, relativePath: string): DocHistoryState {
  let entries = base.entries.slice(0, base.index + 1);
  const previous = entries[entries.length - 1];
  if (previous?.rootId === rootId && previous.relativePath === relativePath) {
    entries[entries.length - 1] = { ...previous, scrollTop: 0 };
  } else {
    entries.push({ rootId, relativePath, scrollTop: 0 });
  }
  if (entries.length > DOC_HISTORY_LIMIT) entries = entries.slice(-DOC_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

// 링크 표기에서 퍼센트 인코딩을 풀고 구분자·쿼리·프래그먼트와 `:12` 같은 줄 번호 꼬리를
// 떼어 경로만 남긴다. 디코드할 수 없는 링크는 비교하지 않고 버린다(null).
// 꺾쇠 벗기기는 두 호출부의 규칙이 달라 여기 넣지 않는다.
function decodeLinkPath(target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  return decoded.replace(/\\/g, "/").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
}

function isMarkdownLink(href: string): boolean {
  const target = decodeLinkPath(href.trim().replace(/^<|>$/g, ""));
  return target !== null && /\.md$/i.test(target);
}

function resolveDocLink(rootPath: string, currentPath: string, href: string): string | null {
  let target = href.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  const decoded = decodeLinkPath(target);
  if (decoded === null) return null;
  target = decoded;
  if (!target) return null;

  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  let segments: string[];
  if (absolute) {
    const rootPrefix = `${root}/`;
    if (target.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
      segments = target.slice(rootPrefix.length).split("/");
    } else if (target.startsWith("/")) {
      segments = target.slice(1).split("/");
    } else {
      return null;
    }
  } else {
    segments = [...currentPath.split("/").slice(0, -1), ...target.split("/")];
  }

  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}
