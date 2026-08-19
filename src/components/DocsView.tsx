import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Download, Eye, Plus, SquarePen, TriangleAlert, X } from "lucide-react";
import {
  createDocRoot,
  deleteDocRoot,
  downloadDocLinkedFile,
  getDoc,
  getDocLinkedFile,
  getDocRoots,
  getDocTree,
  putDoc,
} from "../lib/ipc";
import { formatBytes, formatDate } from "../lib/format";
import type { DocFile, DocRootStatus, FileNode } from "../types";
import { EmptyState, ErrorBanner, LoadingState } from "./Shared";
import { MarkdownPreview } from "./MarkdownPreview";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";

const DOC_HISTORY_LIMIT = 100;

interface DocHistoryEntry {
  rootId: string;
  relativePath: string;
  scrollTop: number;
}

interface DocHistoryState {
  entries: DocHistoryEntry[];
  index: number;
}

export function DocsView() {
  const [roots, setRoots] = useState<DocRootStatus[] | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<DocRootStatus | null>(null);
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [doc, setDoc] = useState<DocFile | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRootForm, setShowRootForm] = useState(false);
  const [rootName, setRootName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [newDocPath, setNewDocPath] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [history, setHistory] = useState<DocHistoryState>({ entries: [], index: -1 });
  const workspaceRef = useRef<HTMLElement>(null);
  const historyRef = useRef<DocHistoryState>({ entries: [], index: -1 });
  const pendingScrollTopRef = useRef<number | null>(null);
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

  const commitHistory = (next: DocHistoryState) => {
    historyRef.current = next;
    setHistory(next);
  };

  const captureCurrentScroll = (): DocHistoryState => {
    const current = historyRef.current;
    const entry = current.entries[current.index];
    if (!doc || !entry || entry.rootId !== doc.rootId || entry.relativePath !== doc.relativePath) {
      return current;
    }
    const scrollTop = workspaceRef.current?.scrollTop ?? entry.scrollTop;
    if (scrollTop === entry.scrollTop) return current;
    const entries = [...current.entries];
    entries[current.index] = { ...entry, scrollTop };
    const next = { entries, index: current.index };
    commitHistory(next);
    return next;
  };

  useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    if (scrollTop === null) return;
    pendingScrollTopRef.current = null;
    workspaceRef.current?.scrollTo({ top: scrollTop, behavior: "auto" });
  }, [doc?.relativePath, doc?.rootId]);

  const loadRoots = useCallback(async () => {
    try {
      const next = await getDocRoots();
      setRoots(next);
      setSelectedRoot((current) => next.find((root) => root.id === current?.id) ?? next[0] ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void loadRoots(); }, [loadRoots]);

  useEffect(() => {
    if (!selectedRoot?.exists) {
      setTree([]);
      return;
    }
    let active = true;
    setTree(null);
    getDocTree(selectedRoot.id)
      .then((value) => active && setTree(value))
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; };
  }, [selectedRoot]);

  const navigateToDocument = async (
    rootId: string,
    relativePath: string,
    historyIndex: number | null = null,
  ) => {
    if (historyIndex === null && doc?.rootId === rootId && doc.relativePath === relativePath) return;
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 이동할까요?")) return;
    const targetRoot = roots?.find((root) => root.id === rootId);
    if (!targetRoot) {
      setError("문서 폴더를 찾을 수 없습니다.");
      return;
    }

    const historyBeforeNavigation = captureCurrentScroll();
    const historyEntry = historyIndex === null
      ? null
      : historyBeforeNavigation.entries[historyIndex];
    if (historyIndex !== null && (
      !historyEntry
      || historyEntry.rootId !== rootId
      || historyEntry.relativePath !== relativePath
    )) return;

    const requestId = ++navigationRequestRef.current;
    setNavigating(true);
    setError(null);
    try {
      const file = await getDoc(rootId, relativePath);
      if (requestId !== navigationRequestRef.current) return;

      let nextHistory: DocHistoryState;
      let scrollTop: number;
      if (historyIndex !== null && historyEntry) {
        nextHistory = { entries: historyBeforeNavigation.entries, index: historyIndex };
        scrollTop = historyEntry.scrollTop;
      } else {
        let entries = historyBeforeNavigation.entries.slice(0, historyBeforeNavigation.index + 1);
        const previous = entries[entries.length - 1];
        if (previous?.rootId === rootId && previous.relativePath === relativePath) {
          entries[entries.length - 1] = { ...previous, scrollTop: 0 };
        } else {
          entries.push({ rootId, relativePath, scrollTop: 0 });
        }
        if (entries.length > DOC_HISTORY_LIMIT) entries = entries.slice(-DOC_HISTORY_LIMIT);
        nextHistory = { entries, index: entries.length - 1 };
        scrollTop = 0;
      }

      commitHistory(nextHistory);
      pendingScrollTopRef.current = scrollTop;
      setSelectedRoot(targetRoot);
      setDoc(file);
      setDraft(file.content);
      setDirty(false);
      setEditing(false);
    } catch (cause) {
      if (requestId === navigationRequestRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === navigationRequestRef.current) setNavigating(false);
    }
  };

  const selectFile = (relativePath: string) => {
    if (selectedRoot) void navigateToDocument(selectedRoot.id, relativePath);
  };

  const moveHistory = (offset: -1 | 1) => {
    const targetIndex = historyRef.current.index + offset;
    const target = historyRef.current.entries[targetIndex];
    if (!target) return;
    void navigateToDocument(target.rootId, target.relativePath, targetIndex);
  };

  const selectRoot = (root: DocRootStatus) => {
    if (selectedRoot?.id === root.id) return;
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 이동할까요?")) return;
    captureCurrentScroll();
    navigationRequestRef.current += 1;
    setNavigating(false);
    linkedFilePreview.close();
    setSelectedRoot(root);
    setDoc(null);
    setDraft("");
    setDirty(false);
    setEditing(false);
  };

  const addRoot = async () => {
    setError(null);
    try {
      const root = await createDocRoot(rootName, rootPath);
      setRootName("");
      setRootPath("");
      setShowRootForm(false);
      await loadRoots();
      setSelectedRoot(root);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeRoot = async (root: DocRootStatus) => {
    if (!window.confirm(`'${root.name}' 등록을 해제할까요? 원본 폴더와 파일은 삭제되지 않습니다.`)) return;
    try {
      await deleteDocRoot(root.id);
      const currentHistory = historyRef.current;
      const entries = currentHistory.entries.filter((entry) => entry.rootId !== root.id);
      const index = currentHistory.entries
        .slice(0, currentHistory.index + 1)
        .filter((entry) => entry.rootId !== root.id).length - 1;
      commitHistory({ entries, index: Math.min(index, entries.length - 1) });
      if (selectedRoot?.id === root.id) {
        navigationRequestRef.current += 1;
        setNavigating(false);
        setSelectedRoot(null);
        setDoc(null);
      }
      await loadRoots();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const createFile = async () => {
    if (!selectedRoot || !newDocPath.trim()) return;
    if (dirty && !window.confirm("저장하지 않은 변경이 있습니다. 새 문서를 만들까요?")) return;
    const historyBeforeNavigation = captureCurrentScroll();
    setSaving(true);
    setError(null);
    try {
      const path = newDocPath.trim().toLowerCase().endsWith(".md") ? newDocPath.trim() : `${newDocPath.trim()}.md`;
      const file = await putDoc(selectedRoot.id, path, "# 새 문서\n", null);
      let entries = historyBeforeNavigation.entries.slice(0, historyBeforeNavigation.index + 1);
      const previous = entries[entries.length - 1];
      if (previous?.rootId === file.rootId && previous.relativePath === file.relativePath) {
        entries[entries.length - 1] = { ...previous, scrollTop: 0 };
      } else {
        entries.push({ rootId: file.rootId, relativePath: file.relativePath, scrollTop: 0 });
      }
      if (entries.length > DOC_HISTORY_LIMIT) entries = entries.slice(-DOC_HISTORY_LIMIT);
      commitHistory({ entries, index: entries.length - 1 });
      pendingScrollTopRef.current = 0;
      setDoc(file);
      setDraft(file.content);
      setDirty(false);
      setEditing(true);
      setNewDocPath("");
      setTree(await getDocTree(selectedRoot.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!doc) return;
    setSaving(true);
    setError(null);
    try {
      const file = await putDoc(doc.rootId, doc.relativePath, draft, doc.modifiedAt);
      setDoc(file);
      setDraft(file.content);
      setDirty(false);
      if (selectedRoot) setTree(await getDocTree(selectedRoot.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const downloadCurrentDoc = async () => {
    if (!doc || downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const fileName = doc.relativePath.split("/").slice(-1)[0];
      await downloadDocLinkedFile(doc.rootId, doc.relativePath, fileName);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(false);
    }
  };

  const openLinkedDoc = (href: string) => {
    if (!doc || !selectedRoot) return;
    if (isMarkdownLink(href)) {
      const relativePath = resolveDocLink(selectedRoot.path, doc.relativePath, href);
      if (!relativePath) {
        setError("문서 폴더 밖의 Markdown 링크는 열 수 없습니다.");
        return;
      }
      selectFile(relativePath);
      return;
    }
    linkedFilePreview.open(href);
  };

  const filteredTree = useMemo(() => filterTree(tree ?? [], query.trim().toLowerCase()), [tree, query]);

  return (
    <div className="docs-layout">
      <aside className="docs-sidebar">
        <div className="docs-sidebar-head"><div><strong>문서 폴더</strong><span>{roots?.length ?? 0}개</span></div><button className="icon-button" type="button" onClick={() => setShowRootForm((value) => !value)} aria-label="문서 폴더 추가"><Plus size={16} /></button></div>
        {showRootForm && <div className="root-form"><input value={rootName} onChange={(event) => setRootName(event.target.value)} placeholder="표시 이름 (선택)" /><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/Users/me/Documents/notes" /><button className="button primary" type="button" disabled={!rootPath.trim()} onClick={addRoot}>폴더 등록</button></div>}
        {roots === null ? <LoadingState label="문서 폴더 확인 중" /> : roots.length === 0 ? <EmptyState title="등록된 폴더 없음" detail="상단 + 버튼에서 로컬 Markdown 폴더를 등록하세요." /> : (
          <div className="root-list">{roots.map((root) => <div className={selectedRoot?.id === root.id ? "root-row active" : "root-row"} key={root.id}><button type="button" onClick={() => selectRoot(root)}>{root.exists ? <ChevronDown size={13} /> : <TriangleAlert size={13} />}<span><strong>{root.name}</strong><code>{root.path}</code></span></button><button className="remove-root" type="button" onClick={() => removeRoot(root)} aria-label="폴더 제거"><X size={13} /></button></div>)}</div>
        )}
        {selectedRoot && <div className="doc-tree-panel">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="파일명 검색" />
          <div className="new-doc-row"><input value={newDocPath} onChange={(event) => setNewDocPath(event.target.value)} onKeyDown={(event) => event.key === "Enter" && !navigating && createFile()} placeholder="새 문서 경로.md" /><button type="button" disabled={saving || navigating || !newDocPath.trim()} onClick={createFile} aria-label="새 문서 만들기"><Plus size={14} /></button></div>
          {tree === null ? <LoadingState label="문서 목록 읽는 중" /> : filteredTree.length === 0 ? <p className="tree-empty">Markdown 문서가 없습니다.</p> : <DocTree nodes={filteredTree} selected={doc?.relativePath ?? null} onSelect={selectFile} />}
        </div>}
      </aside>
      <main className="doc-workspace" ref={workspaceRef}>
        {error && <ErrorBanner message={error} />}
        {!doc ? <EmptyState title="문서를 선택하세요" detail="등록된 폴더의 Markdown 문서를 안전하게 열고 편집할 수 있습니다." /> : (
          <>
            <header className="doc-header"><div><strong>{doc.relativePath.split("/").slice(-1)[0]}</strong><span>{doc.relativePath} · {formatBytes(doc.sizeBytes)} · {formatDate(doc.modifiedAt)}</span></div><div><button className="icon-button" type="button" disabled={downloading} onClick={() => void downloadCurrentDoc()} aria-label="문서 다운로드" title="문서 다운로드"><Download size={15} /></button><button className={editing ? "icon-button active" : "icon-button"} type="button" onClick={() => setEditing((value) => !value)} aria-label={editing ? "미리보기" : "편집"} title={editing ? "미리보기" : "편집"}>{editing ? <Eye size={15} /> : <SquarePen size={15} />}</button>{editing && <button className="button primary" type="button" disabled={saving || !dirty} onClick={save}>{saving ? "저장 중…" : "저장"}</button>}</div></header>
            {selectedRoot?.agentData && <div className="warning-banner">에이전트 데이터 폴더입니다. 저장 전 변경 범위를 확인하세요.</div>}
            {editing ? <textarea className="doc-editor" value={draft} onChange={(event) => { setDraft(event.target.value); setDirty(event.target.value !== doc.content); }} spellCheck={false} /> : <MarkdownPreview source={draft} onOpenLocalLink={openLinkedDoc} />}
          </>
        )}
      </main>
      {doc && <nav className="doc-history-nav" aria-label="문서 이동 기록">
        <button type="button" onClick={() => moveHistory(-1)} disabled={navigating || history.index <= 0} aria-label="이전 문서" title="이전 문서"><ArrowLeft size={17} /></button>
        <button type="button" onClick={() => moveHistory(1)} disabled={navigating || history.index >= history.entries.length - 1} aria-label="다음 문서" title="다음 문서"><ArrowRight size={17} /></button>
      </nav>}
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </div>
  );
}

function isMarkdownLink(href: string): boolean {
  let target = href.trim().replace(/^<|>$/g, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    return false;
  }
  target = target.split(/[?#]/, 1)[0].replace(/:\d+$/, "");
  return /\.md$/i.test(target);
}

function resolveDocLink(rootPath: string, currentPath: string, href: string): string | null {
  let target = href.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  try {
    target = decodeURIComponent(target);
  } catch {
    return null;
  }
  target = target.replace(/\\/g, "/").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
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

function DocTree({ nodes, selected, onSelect, depth = 0 }: { nodes: FileNode[]; selected: string | null; onSelect: (path: string) => void; depth?: number }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  return <div className="doc-tree">{nodes.map((node) => <div key={node.relativePath}>{node.isDirectory ? <button className="tree-row" style={{ paddingLeft: `${depth * 13 + 8}px` }} type="button" onClick={() => setClosed((current) => { const next = new Set(current); if (next.has(node.relativePath)) next.delete(node.relativePath); else next.add(node.relativePath); return next; })}><span>{closed.has(node.relativePath) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span><strong>{node.name}</strong></button> : <button className={selected === node.relativePath ? "tree-row file active" : "tree-row file"} style={{ paddingLeft: `${depth * 13 + 22}px` }} type="button" onClick={() => onSelect(node.relativePath)}><span>·</span><strong>{node.name.replace(/\.md$/i, "")}</strong></button>}{node.isDirectory && !closed.has(node.relativePath) && <DocTree nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />}</div>)}</div>;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    if (!node.isDirectory) return node.relativePath.toLowerCase().includes(query) ? [node] : [];
    const children = filterTree(node.children, query);
    return children.length > 0 ? [{ ...node, children }] : [];
  });
}
