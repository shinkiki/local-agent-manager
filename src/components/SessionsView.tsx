import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronDown, CircleDashed, ExternalLink, Folder, GripVertical, History, LayoutGrid, MessagesSquare, Pencil, Plus, ScrollText, SlidersHorizontal, SquareTerminal, Star, X } from "lucide-react";
import { attachChat, connectChat, removeChatInputFile, type ChatConnection } from "../lib/chat";
import {
  createSessionFolder,
  deleteSessionFolder,
  downloadSessionLinkedFile,
  getDetachedChatForSession,
  getSessionDetail,
  getSessionLinkedFile,
  hasTauriRuntime,
  openProviderSessionApp,
  patchSessionMeta,
  updateSessionFolder,
} from "../lib/ipc";
import { formatBytes, formatDate, formatRelative, formatTokens, sourceName } from "../lib/format";
import type {
  ContentBlock,
  ChatApprovalMode,
  ChatApprovalDecision,
  ChatEvent,
  ChatMode,
  ChatModelCatalogOption,
  ChatPhase,
  ChatReasoningOption,
  ProviderId,
  QueuedChatMessage,
  ReasoningEffort,
  SessionDetail,
  SessionFolder,
  SessionMeta,
  SessionSummary,
  SessionTranscriptLimit,
  TranscriptItem,
} from "../types";
import { reasoningOptionsFor, refreshProviderOptions, useProviderOptions } from "../lib/providerOptions";
import { defaultApprovalMode, reasoningLabel, sameChatSettings, settingFieldsFor, type ChatSettingField } from "../lib/chatSettings";
import { joinMarkdownBlocks } from "../lib/copyPayload";
import { MarkdownPreview } from "./MarkdownPreview";
import { CopyAction } from "./CopyAction";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { ChatApprovalCard, Drawer, EmptyState, ErrorBanner, LoadingState, SourceBadge } from "./Shared";
import { TerminalPanel } from "./TerminalPanel";
import { ChatActivityGroup } from "./ChatActivityGroup";
import { ChatToolCard } from "./ChatToolCard";
import { ChatRuntimeSettingsMenu } from "./ChatRuntimeSettingsMenu";
import {
  appendAttachmentDrafts,
  queuedAttachmentsToDrafts,
  uploadAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { ChatComposer } from "./ChatComposer";
import { SpeechPlaybackAction } from "./VoiceControls";
import {
  applyChatEvent,
  ChatConversationTurn,
  ChatScrollControls,
  type ChatEntry,
  type ChatTurn,
} from "./ChatConversation";

interface SessionsProps {
  sessions: SessionSummary[];
  folders: SessionFolder[];
  selected: SessionSummary | null;
  openAtLatest: boolean;
  onSelect: (session: SessionSummary | null) => void;
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void;
  onFoldersChanged: (folders: SessionFolder[], deletedFolderId?: string) => void;
  attentionTarget: SessionAttentionTarget | null;
  onAttentionTargetHandled: (target: SessionAttentionTarget, opened: boolean) => void;
}

export interface SessionAttentionTarget {
  chatId: string;
  attentionId: string;
  markRead: boolean;
  source: ProviderId;
  sessionId: string;
  requestId: number;
}

type FolderFilter = "all" | "unfiled" | string;

const SESSION_TRANSCRIPT_LIMIT_KEY = "agent-manager.session-transcript-limit";
const DEFAULT_SESSION_TRANSCRIPT_LIMIT: SessionTranscriptLimit = "latest100";
const SESSION_TRANSCRIPT_LIMITS: SessionTranscriptLimit[] = ["latest100", "latest500", "latest1000", "all"];
const SESSION_TRANSCRIPT_CHUNK_SIZES: Partial<Record<SessionTranscriptLimit, number>> = {
  latest100: 100,
  latest500: 500,
  latest1000: 1000,
};

export function SessionsView({ sessions, folders, selected, openAtLatest, onSelect, onMetaChanged, onFoldersChanged, attentionTarget, onAttentionTargetHandled }: SessionsProps) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<ProviderId | "all">("all");
  const [project, setProject] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [transcriptLimit, setTranscriptLimit] = useState<SessionTranscriptLimit>(readSessionTranscriptLimit);
  const [draggedSession, setDraggedSession] = useState<SessionSummary | null>(null);
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number } | null>(null);
  const [pointerDropTarget, setPointerDropTarget] = useState<string | null>(null);
  const pointerDragRef = useRef<{ session: SessionSummary; startX: number; startY: number; active: boolean } | null>(null);
  const suppressNextClickRef = useRef(false);
  const handleAttentionAttach = useCallback((opened: boolean) => {
    if (attentionTarget) onAttentionTargetHandled(attentionTarget, opened);
  }, [attentionTarget, onAttentionTargetHandled]);
  const [folderError, setFolderError] = useState<string | null>(null);

  const changeTranscriptLimit = useCallback((next: SessionTranscriptLimit) => {
    setTranscriptLimit(next);
    try {
      window.localStorage.setItem(SESSION_TRANSCRIPT_LIMIT_KEY, next);
    } catch {
      // The selected limit still applies to every session for the current app run.
    }
  }, []);

  const projects = useMemo(() => {
    const counts = new Map<string, { name: string; count: number }>();
    for (const session of sessions) {
      if (!session.cwd) continue;
      const current = counts.get(session.cwd) ?? { name: session.project ?? session.cwd, count: 0 };
      current.count += 1;
      counts.set(session.cwd, current);
    }
    return [...counts.entries()].sort((left, right) => right[1].count - left[1].count);
  }, [sessions]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (source !== "all" && session.source !== source) return false;
      if (project !== "all" && session.cwd !== project) return false;
      if (!showHidden && session.meta.hidden) return false;
      if (showHidden && !session.meta.hidden) return false;
      if (!includeArchived && session.archived) return false;
      if (!includeSubagents && session.isSubagent) return false;
      if (favoritesOnly && !session.meta.favorite) return false;
      if (folderFilter === "unfiled" && session.meta.folderIds.length > 0) return false;
      if (folderFilter !== "all" && folderFilter !== "unfiled" && !session.meta.folderIds.includes(folderFilter)) return false;
      if (!needle) return true;
      return [session.title, session.project, session.cwd, session.id, session.meta.note]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [sessions, source, project, showHidden, includeArchived, includeSubagents, favoritesOnly, folderFilter, query]);

  useEffect(() => {
    if (!selected) return;
    const remainsVisible = filtered.some((session) => (
      session.source === selected.source && session.id === selected.id
    ));
    if (!remainsVisible) onSelect(null);
  }, [filtered, onSelect, selected]);

  const assignToFolder = useCallback(async (session: SessionSummary, folderId: string | null) => {
    const folderIds = folderId === null
      ? []
      : session.meta.folderIds.includes(folderId)
        ? session.meta.folderIds
        : [...session.meta.folderIds, folderId];
    if (folderIds.length === session.meta.folderIds.length && folderIds.every((id, index) => id === session.meta.folderIds[index])) return;
    setFolderError(null);
    try {
      const meta = await patchSessionMeta(session.source, session.id, { folderIds });
      onMetaChanged(session.source, session.id, meta);
    } catch (cause) {
      setFolderError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onMetaChanged]);

  useEffect(() => {
    const targetAt = (event: PointerEvent): string | null =>
      document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-folder-drop-id]")
        ?.dataset.folderDropId ?? null;
    const clear = () => {
      pointerDragRef.current = null;
      setDraggedSession(null);
      setDragPreview(null);
      setPointerDropTarget(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current) return;
      if (!current.active) {
        const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
        if (distance < 6) return;
        current.active = true;
        setDraggedSession(current.session);
      }
      if (event.cancelable) event.preventDefault();
      setDragPreview({ x: event.clientX, y: event.clientY });
      setPointerDropTarget(targetAt(event));
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current) return;
      const target = current.active ? targetAt(event) : null;
      if (current.active) {
        if (event.cancelable) event.preventDefault();
        suppressNextClickRef.current = true;
      }
      const session = current.session;
      clear();
      if (target) void assignToFolder(session, target === "unfiled" ? null : target);
    };
    const preventScroll = (event: WheelEvent) => {
      if (pointerDragRef.current?.active && event.cancelable) event.preventDefault();
    };
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("wheel", preventScroll, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("wheel", preventScroll);
    };
  }, [assignToFolder]);

  return (
    <div className="sessions-layout">
      <SessionFolderSidebar
        sessions={sessions}
        folders={folders}
        active={folderFilter}
        draggedSession={draggedSession}
        dropTarget={pointerDropTarget}
        onSelect={setFolderFilter}
        onFoldersChanged={onFoldersChanged}
      />
      {draggedSession && dragPreview && <div className="session-drag-preview" style={{ left: dragPreview.x + 14, top: dragPreview.y + 14 }} aria-hidden="true"><span className="drag-preview-grip"><GripVertical size={14} /></span><SourceBadge source={draggedSession.source} /><strong>{draggedSession.title}</strong></div>}
      <div className="session-list-pane">
      {folderError && <ErrorBanner message={folderError} />}
      <section className="toolbar-card">
        <div className="source-tabs">
          {(["all", "claude", "codex", "antigravity"] as const).map((item) => (
            <button
              className={source === item ? "active" : ""}
              key={item}
              type="button"
              onClick={() => setSource(item)}
            >
              {item === "all" ? "전체" : sourceName(item)}
            </button>
          ))}
        </div>
        <input
          className="search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="제목·프로젝트·ID·메모 검색"
        />
        <select value={project} onChange={(event) => setProject(event.target.value)}>
          <option value="all">프로젝트 전체</option>
          {projects.map(([path, item]) => (
            <option value={path} key={path}>{item.name} ({item.count})</option>
          ))}
        </select>
        <label className="check-filter"><input type="checkbox" checked={favoritesOnly} onChange={(event) => setFavoritesOnly(event.target.checked)} /> 즐겨찾기</label>
        <label className="check-filter"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> 숨김만</label>
        <details className="more-filter">
          <summary>추가 필터</summary>
          <label><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> 보관 세션 포함</label>
          <label><input type="checkbox" checked={includeSubagents} onChange={(event) => setIncludeSubagents(event.target.checked)} /> 서브에이전트 포함</label>
        </details>
      </section>

      <section className="panel table-panel">
        <div className="table-caption">
          <strong>세션 {filtered.length.toLocaleString()}개</strong>
          <span>행을 폴더로 드래그해 분류하거나, 선택해서 대화 내역을 확인하세요.</span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState title="조건에 맞는 세션이 없습니다" detail="필터를 바꾸거나 새로고침해 보세요." />
        ) : (
          <div className="table-scroll">
            <table className="data-table session-table">
              <thead>
                <tr><th>소스</th><th>제목</th><th>프로젝트</th><th>모델</th><th>메시지</th><th>토큰</th><th>업데이트</th></tr>
              </thead>
              <tbody>
                {filtered.map((session) => (
                  <tr
                    className={draggedSession?.source === session.source && draggedSession.id === session.id ? "is-dragging" : ""}
                    key={`${session.source}:${session.id}`}
                    onClick={() => {
                      if (suppressNextClickRef.current) {
                        suppressNextClickRef.current = false;
                        return;
                      }
                      onSelect(session);
                    }}
                    onPointerDown={(event: ReactPointerEvent<HTMLTableRowElement>) => {
                      if (event.button !== 0) return;
                      // Touch/pen scrolls cancel row drags anyway (preventDefault on pointermove
                      // cannot stop panning), so arming them here only janks the first scroll
                      // frames. Touch drags start from the grip, which opts out via touch-action.
                      if (event.pointerType !== "mouse" && !(event.target as Element).closest?.(".drag-grip")) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      pointerDragRef.current = {
                        session,
                        startX: event.clientX,
                        startY: event.clientY,
                        active: false,
                      };
                    }}
                  >
                    <td><span className="session-source-cell"><span className="drag-grip" title="폴더로 드래그"><GripVertical size={13} /></span><SourceBadge source={session.source} /></span></td>
                    <td>
                      <div className="title-cell">
                        <strong>{session.meta.favorite && <span className="favorite-star"><Star size={11} fill="currentColor" strokeWidth={0} /></span>}{session.title}</strong>
                        {session.meta.folderIds.length > 0 && <div className="session-folder-chips">{session.meta.folderIds.slice(0, 3).map((folderId) => {
                          const folder = folders.find((item) => item.id === folderId);
                          return folder ? <span style={{ "--folder-color": folder.color } as CSSProperties} key={folder.id}>{folder.name}</span> : null;
                        })}</div>}
                      </div>
                    </td>
                    <td><div className="project-cell"><span className="cell-main">{session.project ?? "–"}</span><small title={session.cwd ?? undefined}>{session.gitBranch ?? ""}</small></div></td>
                    <td><code>{session.model ?? "–"}</code></td>
                    <td>{session.messageCount?.toLocaleString() ?? "–"}</td>
                    <td>{formatTokens(session.tokenTotal)}</td>
                    <td title={formatDate(session.updatedAt)}>{formatRelative(session.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      </div>

      {selected && (
        <SessionDrawer
          key={`${selected.source}:${selected.id}`}
          session={selected}
          folders={folders}
          openAtLatest={openAtLatest}
          transcriptLimit={transcriptLimit}
          onClose={() => onSelect(null)}
          onMetaChanged={onMetaChanged}
          onTranscriptLimitChange={changeTranscriptLimit}
          attachChatId={attentionTarget?.source === selected.source && attentionTarget.sessionId === selected.id ? attentionTarget.chatId : null}
          attachRequestId={attentionTarget?.requestId ?? 0}
          onAttachHandled={handleAttentionAttach}
        />
      )}
    </div>
  );
}

function SessionFolderSidebar({
  sessions,
  folders,
  active,
  draggedSession,
  dropTarget,
  onSelect,
  onFoldersChanged,
}: {
  sessions: SessionSummary[];
  folders: SessionFolder[];
  active: FolderFilter;
  draggedSession: SessionSummary | null;
  dropTarget: string | null;
  onSelect: (folder: FolderFilter) => void;
  onFoldersChanged: (folders: SessionFolder[], deletedFolderId?: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#f0b054");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState("#f0b054");
  const [deleteCandidate, setDeleteCandidate] = useState<SessionFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unfiledCount = sessions.filter((session) => session.meta.folderIds.length === 0).length;

  const createFolder = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const folder = await createSessionFolder(name, color);
      onFoldersChanged([...folders, folder]);
      setName("");
      setCreating(false);
      onSelect(folder.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveFolder = async (id: string) => {
    if (!editingName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await updateSessionFolder(id, { name: editingName, color: editingColor });
      onFoldersChanged(folders.map((folder) => folder.id === id ? updated : folder));
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (folder: SessionFolder) => {
    setBusy(true);
    setError(null);
    try {
      await deleteSessionFolder(folder.id);
      onFoldersChanged(folders.filter((item) => item.id !== folder.id), folder.id);
      if (active === folder.id) onSelect("all");
      setDeleteCandidate(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="session-folders">
      <header>
        <div><strong>폴더</strong><span>{folders.length}</span></div>
        <button className="folder-add-button" type="button" onClick={() => setCreating((value) => !value)} title="폴더 추가"><Plus size={15} /></button>
      </header>
      {creating && <div className="folder-create-form">
        <div><input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="폴더 색상" /><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createFolder()} placeholder="새 폴더 이름" autoFocus /></div>
        <div><button type="button" onClick={() => setCreating(false)}>취소</button><button className="primary" type="button" disabled={!name.trim() || busy} onClick={createFolder}>추가</button></div>
      </div>}
      {deleteCandidate && <div className="folder-delete-confirm" role="alertdialog" aria-label="폴더 삭제 확인"><p>'{deleteCandidate.name}' 폴더를 삭제할까요? 세션과 원본 대화는 삭제되지 않습니다.</p><div><button type="button" disabled={busy} onClick={() => setDeleteCandidate(null)}>취소</button><button className="danger" type="button" disabled={busy} onClick={() => void removeFolder(deleteCandidate)}>{busy ? "삭제 중…" : "삭제"}</button></div></div>}
      {error && <p className="folder-error">{error}</p>}
      <div className="folder-list">
        <button className={active === "all" ? "folder-filter active" : "folder-filter"} type="button" onClick={() => onSelect("all")}>
          <span className="folder-symbol all"><LayoutGrid size={14} strokeWidth={1.8} /></span><strong>전체 세션</strong><em>{sessions.length}</em>
        </button>
        <button
          data-folder-drop-id="unfiled"
          className={`${active === "unfiled" ? "folder-filter active" : "folder-filter"}${dropTarget === "unfiled" ? " drop-target" : ""}`}
          type="button"
          onClick={() => onSelect("unfiled")}
        >
          <span className="folder-symbol unfiled"><CircleDashed size={14} /></span><strong>미분류</strong><em>{unfiledCount}</em>
        </button>
        <div className="folder-divider"><span>내 폴더</span>{draggedSession && <em>여기에 놓아 추가</em>}</div>
        {folders.map((folder) => editingId === folder.id ? (
          <div className="folder-edit-row" key={folder.id}>
            <input type="color" value={editingColor} onChange={(event) => setEditingColor(event.target.value)} aria-label="폴더 색상" />
            <input value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveFolder(folder.id); if (event.key === "Escape") setEditingId(null); }} autoFocus />
            <button type="button" disabled={busy} onClick={() => saveFolder(folder.id)}><Check size={13} /></button>
          </div>
        ) : (
          <div
            data-folder-drop-id={folder.id}
            className={`${active === folder.id ? "folder-entry active" : "folder-entry"}${dropTarget === folder.id ? " drop-target" : ""}`}
            key={folder.id}
          >
            <button className="folder-entry-main" type="button" onClick={() => onSelect(folder.id)}>
              <span className="folder-symbol" style={{ "--folder-color": folder.color } as CSSProperties}><Folder size={13} fill="currentColor" strokeWidth={0} /></span>
              <strong>{folder.name}</strong><em>{folder.sessionCount}</em>
            </button>
            <div className="folder-entry-actions">
              <button type="button" title="이름 변경" onClick={() => { setEditingId(folder.id); setEditingName(folder.name); setEditingColor(folder.color); }}><Pencil size={12} /></button>
              <button type="button" title="삭제" onClick={() => setDeleteCandidate(folder)}><X size={13} /></button>
            </div>
          </div>
        ))}
      </div>
      <footer><span><GripVertical size={13} /></span> 세션 행을 폴더로 드래그하세요.</footer>
    </aside>
  );
}

function SessionDrawer({
  session,
  folders,
  openAtLatest,
  transcriptLimit,
  onClose,
  onMetaChanged,
  onTranscriptLimitChange,
  attachChatId,
  attachRequestId,
  onAttachHandled,
}: {
  session: SessionSummary;
  folders: SessionFolder[];
  openAtLatest: boolean;
  transcriptLimit: SessionTranscriptLimit;
  onClose: () => void;
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void;
  onTranscriptLimitChange: (limit: SessionTranscriptLimit) => void;
  attachChatId: string | null;
  attachRequestId: number;
  onAttachHandled: (opened: boolean) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const [title, setTitle] = useState(session.meta.customTitle ?? "");
  const [note, setNote] = useState(session.meta.note ?? "");
  const [saving, setSaving] = useState(false);
  const [openingProviderApp, setOpeningProviderApp] = useState(false);
  const [meta, setMeta] = useState(session.meta);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"conversation" | "activity" | "terminal">("conversation");
  const [continuationText, setContinuationText] = useState("");
  const [continuationAttachments, setContinuationAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [continuationUploading, setContinuationUploading] = useState(false);
  const [continuationMode, setContinuationMode] = useState<ChatMode>(session.meta.mode ?? "workspace");
  const [continuationApprovalMode, setContinuationApprovalMode] = useState<ChatApprovalMode>(session.meta.approvalMode ?? defaultApprovalMode(session.source));
  const [continuationModel, setContinuationModel] = useState(session.model ?? "");
  const [continuationReasoningEffort, setContinuationReasoningEffort] = useState<ReasoningEffort | "">(session.meta.reasoningEffort ?? "");
  const [continuationExtraSettings, setContinuationExtraSettings] = useState<Record<string, string>>({});
  const [continuationPhase, setContinuationPhase] = useState<ChatPhase | "idle" | "connecting">("idle");
  const [continuationTurns, setContinuationTurns] = useState<ChatTurn[]>([]);
  const [continuationQueue, setContinuationQueue] = useState<QueuedChatMessage[]>([]);
  const [continuationError, setContinuationError] = useState<string | null>(null);
  const drawerBodyRef = useRef<HTMLDivElement>(null);
  const earlierScrollAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  const initialPositionAppliedRef = useRef(false);
  const followLatestMessagesRef = useRef(openAtLatest);
  const continuationRef = useRef<ChatConnection | null>(null);
  const continuationAttachmentsRef = useRef<ChatAttachmentDraft[]>([]);
  const continuationGenerationRef = useRef(0);
  const continuationActiveTurnRef = useRef<string | null>(null);
  const loadLinkedFile = useCallback(
    (href: string) => getSessionLinkedFile(session.source, session.id, href),
    [session.id, session.source],
  );
  const downloadLinkedFile = useCallback(
    (href: string) => downloadSessionLinkedFile(session.source, session.id, href),
    [session.id, session.source],
  );
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);
  const providerOptions = useProviderOptions(session.source);
  const continuationModelOptions = providerOptions?.models ?? [];
  const continuationReasoningOptions = reasoningOptionsFor(providerOptions, continuationModel);

  const handleContinuationEvent = useCallback((event: ChatEvent, generation: number) => {
    if (generation !== continuationGenerationRef.current) return;
    applyChatEvent(event, {
      activeTurnRef: continuationActiveTurnRef,
      setTurns: setContinuationTurns,
      setQueue: setContinuationQueue,
      onState: (info) => {
        setContinuationPhase(info.state);
        setContinuationExtraSettings(info.settings ?? {});
        if (info.state === "stopped" || info.state === "failed") {
          setContinuationQueue([]);
          const connection = continuationRef.current;
          continuationRef.current = null;
          if (connection) void connection.detach();
        }
      },
      onError: setContinuationError,
    });
  }, []);

  useEffect(() => {
    let active = true;
    initialPositionAppliedRef.current = false;
    earlierScrollAnchorRef.current = null;
    setDetail(null);
    setError(null);
    setLoadingEarlier(false);
    setEarlierError(null);
    getSessionDetail(session.source, session.id, transcriptLimit)
      .then((value) => active && setDetail(value))
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; };
  }, [session.source, session.id, transcriptLimit]);

  // 이전 구간 조회용 커서. tail 파싱에서는 항목 순번이 아니라 원본 파일의
  // 바이트 오프셋이므로 개수처럼 표시하면 안 된다. 0이면 앞선 항목이 없다.
  const oldestTranscriptIndex = useMemo(() => (
    detail && detail.transcript.length > 0
      ? detail.transcript.reduce((min, item) => Math.min(min, item.index), Number.MAX_SAFE_INTEGER)
      : 0
  ), [detail]);
  const earlierChunkSize = SESSION_TRANSCRIPT_CHUNK_SIZES[transcriptLimit];
  const earlierLoadCount = detail?.truncated && earlierChunkSize
    ? Math.min(earlierChunkSize, oldestTranscriptIndex)
    : 0;

  const loadEarlierTranscript = useCallback(async () => {
    if (loadingEarlier || earlierLoadCount <= 0) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    const body = drawerBodyRef.current;
    const anchor = body ? { height: body.scrollHeight, top: body.scrollTop } : null;
    try {
      const page = await getSessionDetail(session.source, session.id, transcriptLimit, oldestTranscriptIndex);
      earlierScrollAnchorRef.current = anchor;
      setDetail((prev) => prev && {
        ...prev,
        transcript: [...page.transcript, ...prev.transcript],
        truncated: page.transcript.length > 0 ? page.truncated : false,
      });
    } catch (cause) {
      setEarlierError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingEarlier(false);
    }
  }, [earlierLoadCount, loadingEarlier, oldestTranscriptIndex, session.id, session.source, transcriptLimit]);

  // 이전 구간을 위쪽에 붙인 뒤에도 보고 있던 위치가 유지되도록 스크롤을 보정한다.
  useLayoutEffect(() => {
    const anchor = earlierScrollAnchorRef.current;
    if (!anchor) return;
    earlierScrollAnchorRef.current = null;
    const body = drawerBodyRef.current;
    if (body) body.scrollTop = anchor.top + (body.scrollHeight - anchor.height);
  }, [detail]);

  useEffect(() => {
    followLatestMessagesRef.current = openAtLatest;
  }, [openAtLatest, session.id]);

  const pauseFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = false;
  }, []);
  const resumeFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = openAtLatest;
  }, [openAtLatest]);

  useEffect(() => () => {
    continuationGenerationRef.current += 1;
    const connection = continuationRef.current;
    continuationRef.current = null;
    if (connection) void connection.detach();
  }, []);

  useEffect(() => {
    const connected = continuationRef.current;
    if (connected && (!attachChatId || connected.info.chatId === attachChatId)) {
      if (attachChatId) {
        setActiveTab("conversation");
        onAttachHandled(true);
      }
      return undefined;
    }
    if (connected) {
      setContinuationError("다른 실행이 이미 이 세션 상세에 연결되어 있습니다.");
      if (attachChatId) onAttachHandled(false);
      return undefined;
    }
    if (session.isSubagent) {
      if (attachChatId) onAttachHandled(false);
      return undefined;
    }

    let cancelled = false;
    const generation = continuationGenerationRef.current + 1;
    continuationGenerationRef.current = generation;
    setContinuationError(null);
    setContinuationPhase("connecting");
    void (async () => {
      let chatId = attachChatId;
      if (!chatId) {
        for (let attempt = 0; attempt < 4 && !chatId; attempt += 1) {
          const detached = await getDetachedChatForSession(session.source, session.id);
          if (cancelled) return null;
          chatId = detached?.chatId ?? null;
          if (!chatId && attempt < 3) {
            await new Promise((resolve) => window.setTimeout(resolve, 75));
          }
        }
      }
      if (!chatId) return null;
      setActiveTab("conversation");
      // attach는 백엔드가 과거 이벤트를 리플레이하므로 스트림을 리플레이 기준으로 다시 채운다.
      continuationActiveTurnRef.current = null;
      setContinuationTurns([]);
      return attachChat(chatId, (event) => handleContinuationEvent(event, generation));
    })()
      .then((connection) => {
        if (cancelled) {
          if (connection) void connection.detach();
          return;
        }
        if (!connection) {
          setContinuationPhase("idle");
          return;
        }
        continuationRef.current = connection;
        setContinuationMode(connection.info.mode);
        setContinuationApprovalMode(connection.info.approvalMode);
        setContinuationModel(connection.info.model ?? "");
        setContinuationReasoningEffort(connection.info.reasoningEffort ?? "");
        setContinuationExtraSettings(connection.info.settings ?? {});
        setContinuationPhase(connection.info.state);
        if (attachChatId) onAttachHandled(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setContinuationPhase("idle");
        const label = attachChatId ? "알림의 실행" : "기존 CLI 실행";
        setContinuationError(`${label}에 다시 연결하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (attachChatId) onAttachHandled(false);
      });
    return () => { cancelled = true; };
  }, [attachChatId, attachRequestId, handleContinuationEvent, onAttachHandled, session.id, session.isSubagent, session.source]);

  useEffect(() => {
    if (!openAtLatest || initialPositionAppliedRef.current || activeTab !== "conversation" || !detail) return undefined;
    initialPositionAppliedRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const body = drawerBodyRef.current;
      if (body) body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, openAtLatest, detail]);

  useEffect(() => {
    if (!openAtLatest || !followLatestMessagesRef.current || activeTab !== "conversation" || continuationTurns.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!followLatestMessagesRef.current) return;
      const body = drawerBodyRef.current;
      if (body) body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, openAtLatest, continuationTurns]);

  const addContinuationFiles = (files: File[]) => {
    setContinuationAttachments((current) => {
      const result = appendAttachmentDrafts(current, files);
      if (result.error) setContinuationError(result.error);
      continuationAttachmentsRef.current = result.drafts;
      return result.drafts;
    });
  };

  const removeContinuationAttachment = (draft: ChatAttachmentDraft) => {
    const next = continuationAttachmentsRef.current.filter((item) => item.key !== draft.key);
    continuationAttachmentsRef.current = next;
    setContinuationAttachments(next);
    if (draft.uploaded && draft.ownedUpload && continuationRef.current) {
      void removeChatInputFile(continuationRef.current.info.chatId, draft.uploaded.id).catch(() => undefined);
    }
  };

  const deliverContinuation = async (steer: boolean) => {
    const text = continuationText.trim();
    const drafts = continuationAttachmentsRef.current;
    if ((!text && drafts.length === 0) || continuationPhase === "connecting" || continuationUploading) return;
    if (!session.cwd) {
      setContinuationError("세션에 저장된 작업 경로가 없어 대화를 이어갈 수 없습니다.");
      return;
    }
    if (session.isSubagent) {
      setContinuationError("서브에이전트 세션은 직접 이어가기 대상이 아닙니다.");
      return;
    }
    setContinuationError(null);
    let connection = continuationRef.current;
    if (!connection) {
      setContinuationPhase("connecting");
      const generation = continuationGenerationRef.current + 1;
      continuationGenerationRef.current = generation;
      try {
        connection = await connectChat({
          source: session.source,
          cwd: session.cwd,
          model: continuationModel || null,
          reasoningEffort: continuationReasoningEffort || null,
          mode: continuationMode,
          approvalMode: continuationApprovalMode,
          resumeSessionId: session.id,
          unattended: false,
          settings: continuationExtraSettings,
        }, (event) => handleContinuationEvent(event, generation));
        continuationRef.current = connection;
        setContinuationPhase(connection.info.state);
      } catch (cause) {
        continuationRef.current = null;
        setContinuationPhase("idle");
        setContinuationError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
    }
    setContinuationUploading(true);
    try {
      const uploaded = await uploadAttachmentDrafts(connection.info.chatId, drafts, (next) => {
        continuationAttachmentsRef.current = next;
        setContinuationAttachments(next);
      });
      await connection.send(text, {
        steer,
        attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []),
      });
      setContinuationText("");
      continuationAttachmentsRef.current = [];
      setContinuationAttachments([]);
    } catch (cause) {
      setContinuationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContinuationUploading(false);
    }
  };

  interface ContinuationSettings {
    mode: ChatMode;
    approvalMode: ChatApprovalMode;
    model: string;
    reasoningEffort: ReasoningEffort | "";
    extraSettings: Record<string, string>;
  }

  const changeContinuationSettings = async (next: Partial<ContinuationSettings>, label: string) => {
    const target: ContinuationSettings = {
      mode: continuationMode,
      approvalMode: continuationApprovalMode,
      model: continuationModel,
      reasoningEffort: continuationReasoningEffort,
      extraSettings: continuationExtraSettings,
      ...next,
    };
    if ((target.mode === continuationMode
      && target.approvalMode === continuationApprovalMode
      && target.model === continuationModel
      && target.reasoningEffort === continuationReasoningEffort
      && sameChatSettings(target.extraSettings, continuationExtraSettings))
      || continuationPhase === "connecting"
      || continuationPhase === "running"
      || continuationPhase === "waitingApproval") return;

    const previous: ContinuationSettings = {
      mode: continuationMode,
      approvalMode: continuationApprovalMode,
      model: continuationModel,
      reasoningEffort: continuationReasoningEffort,
      extraSettings: continuationExtraSettings,
    };
    const previousPhase = continuationPhase;
    const connection = continuationRef.current;
    const apply = (settings: ContinuationSettings) => {
      setContinuationMode(settings.mode);
      setContinuationApprovalMode(settings.approvalMode);
      setContinuationModel(settings.model);
      setContinuationReasoningEffort(settings.reasoningEffort);
      setContinuationExtraSettings(settings.extraSettings);
    };
    apply(target);
    setContinuationError(null);
    if (!connection) return;

    setContinuationPhase("connecting");
    try {
      await connection.stop();
    } catch (cause) {
      apply(previous);
      setContinuationPhase(previousPhase);
      setContinuationError(`${label} 변경하지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }

    continuationGenerationRef.current += 1;
    continuationRef.current = null;
    try { await connection.detach(); } catch { /* The stopped provider process is safe to leave detached. */ }
    setContinuationQueue([]);
    setContinuationPhase("idle");
  };

  const changeContinuationMode = (nextMode: ChatMode) =>
    changeContinuationSettings({ mode: nextMode }, "요청 모드를");

  const changeContinuationApprovalMode = (nextMode: ChatApprovalMode) =>
    changeContinuationSettings({ approvalMode: nextMode }, "승인 처리를");

  const changeContinuationModel = (nextModel: string) =>
    changeContinuationSettings({ model: nextModel }, "응답 모델을");

  const changeContinuationReasoningEffort = (nextEffort: ReasoningEffort | "") =>
    changeContinuationSettings({ reasoningEffort: nextEffort }, "추론 수준을");

  const changeContinuationExtraSettings = (nextSettings: Record<string, string>) =>
    changeContinuationSettings({ extraSettings: nextSettings }, "추가 설정을");

  const sendContinuation = async (event: FormEvent) => {
    event.preventDefault();
    await deliverContinuation(false);
  };

  const removeContinuationQueued = async (messageId: string) => {
    setContinuationError(null);
    try {
      await continuationRef.current?.removeQueued(messageId);
    } catch (cause) {
      setContinuationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const recallContinuationQueued = async (message: QueuedChatMessage) => {
    setContinuationError(null);
    try {
      await continuationRef.current?.removeQueued(message.id);
      setContinuationText((current) => current.trim() ? `${current}\n${message.text}` : message.text);
      const attachments = [...continuationAttachmentsRef.current, ...queuedAttachmentsToDrafts(message.attachments)];
      continuationAttachmentsRef.current = attachments;
      setContinuationAttachments(attachments);
    } catch (cause) {
      setContinuationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const decideContinuation = async (approvalId: string, decision: ChatApprovalDecision) => {
    setContinuationError(null);
    try {
      await continuationRef.current?.approve(approvalId, decision);
    } catch (cause) {
      setContinuationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const interruptContinuation = async () => {
    setContinuationError(null);
    try {
      await continuationRef.current?.interrupt();
    } catch (cause) {
      setContinuationError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openInCodex = async () => {
    if (session.source !== "codex" || openingProviderApp) return;
    setOpeningProviderApp(true);
    setError(null);
    const connection = continuationRef.current;
    continuationRef.current = null;
    try {
      if (connection) {
        try { await connection.stop(); } catch { /* The provider process may already be gone. */ }
        try { await connection.detach(); } catch { /* The handoff can still continue. */ }
        setContinuationPhase("stopped");
        setContinuationQueue([]);
      }
      await openProviderSessionApp(session.source, session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningProviderApp(false);
    }
  };

  const patchMeta = async (patch: Partial<SessionMeta>) => {
    setSaving(true);
    setError(null);
    try {
      const next = await patchSessionMeta(session.source, session.id, patch);
      setMeta(next);
      onMetaChanged(session.source, session.id, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const messageCount = session.messageCount ?? conversationMessageCount(detail);
  const pendingApprovals = continuationTurns.flatMap((turn) => turn.entries).filter((entry): entry is Extract<ChatEntry, { type: "approval" }> => entry.type === "approval" && entry.interactive && !entry.resolved);

  const toggleSettings = () => setSettingsExpanded((current) => !current);
  useEffect(() => {
    if (!settingsExpanded) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (settingsPanelRef.current?.contains(target) || settingsToggleRef.current?.contains(target)) return;
      setSettingsExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsExpanded]);

  return (
    <>
    <Drawer
      title={<>
        <SourceBadge source={session.source} />
        <button
          className={`session-favorite-toggle${meta.favorite ? " active" : ""}`}
          type="button"
          disabled={saving}
          aria-label={meta.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
          aria-pressed={meta.favorite}
          title={meta.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
          onClick={() => patchMeta({ favorite: !meta.favorite })}
        >
          <Star size={16} fill={meta.favorite ? "currentColor" : "none"} aria-hidden="true" />
        </button>
        <span data-user-content>{meta.customTitle ?? session.sourceTitle ?? session.title}</span>
      </>}
      actions={<>
        {hasTauriRuntime() && session.source === "codex" && <button
          className="button compact session-provider-open"
          type="button"
          disabled={openingProviderApp || continuationPhase === "connecting" || continuationPhase === "running" || continuationPhase === "waitingApproval"}
          onClick={() => void openInCodex()}
          title="이 연결을 종료하고 같은 대화를 Codex 앱에서 엽니다"
        ><ExternalLink size={13} /><span>{openingProviderApp ? "여는 중…" : "Codex에서 열기"}</span></button>}
        <button
          className={`button compact session-settings-toggle${settingsExpanded ? " active" : ""}`}
          type="button"
          ref={settingsToggleRef}
          aria-expanded={settingsExpanded}
          aria-controls="session-drawer-settings"
          onClick={toggleSettings}
          title={settingsExpanded ? "세션 설정 접기" : "세션 설정 펼치기"}
        >
          <SlidersHorizontal size={13} />
          <span>세션 설정</span>
          <ChevronDown className="session-settings-chevron" size={13} aria-hidden="true" />
        </button>
      </>}
      headerContent={<div className="session-drawer-header-content">
        {settingsExpanded && <div className="session-drawer-settings" id="session-drawer-settings" ref={settingsPanelRef}>
          <section className="session-settings-toolbar" aria-label="세션 관리">
            <div className="detail-actions">
              <button className={meta.favorite ? "button primary" : "button"} type="button" disabled={saving} onClick={() => patchMeta({ favorite: !meta.favorite })}>
                <Star size={13} fill={meta.favorite ? "currentColor" : "none"} aria-hidden="true" /> 즐겨찾기
              </button>
              <button className="button danger-subtle" type="button" disabled={saving} onClick={() => patchMeta({ hidden: !meta.hidden })}>
                {meta.hidden ? "숨김 해제" : "숨기기"}
              </button>
            </div>
            <label className="session-transcript-range">
              <span><strong>대화 내역 표시 범위</strong><small>{detail ? `${detail.transcript.length.toLocaleString()}개 항목 표시 중` : "불러오는 중"}</small></span>
              <select
                aria-label="세션 대화 표시 범위"
                value={transcriptLimit}
                onChange={(event) => onTranscriptLimitChange(event.target.value as SessionTranscriptLimit)}
              >
                <option value="latest100">최신 100개</option>
                <option value="latest500">최신 500개</option>
                <option value="latest1000">최신 1,000개</option>
                <option value="all">전체</option>
              </select>
            </label>
          </section>

          <section className="session-folder-picker">
            <span>폴더</span>
            <div>
              {folders.length === 0 ? <small>등록된 폴더가 없습니다.</small> : folders.map((folder) => {
                const assigned = meta.folderIds.includes(folder.id);
                return <button
                  className={assigned ? "assigned" : ""}
                  style={{ "--folder-color": folder.color } as CSSProperties}
                  type="button"
                  disabled={saving}
                  key={folder.id}
                  onClick={() => patchMeta({ folderIds: assigned ? meta.folderIds.filter((id) => id !== folder.id) : [...meta.folderIds, folder.id] })}
                >
                  <i />{folder.name}{assigned && <Check size={11} />}
                </button>;
              })}
            </div>
          </section>

          <section className="detail-card session-metadata-settings">
            <h4>메타데이터 설정</h4>
            <div className="form-row"><label htmlFor="session-title">표시 제목</label><input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={session.sourceTitle ?? "제목 입력"} /></div>
            <div className="form-row"><label htmlFor="session-note">메모</label><textarea id="session-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="이 세션에 대한 메모" rows={3} /></div>
            <div className="form-actions"><button className="button primary" type="button" disabled={saving} onClick={() => patchMeta({ customTitle: title || null, note: note || null })}>{saving ? "저장 중…" : "메타데이터 저장"}</button></div>
          </section>

          <section className="detail-card session-detail-settings">
            <h4>상세정보</h4>
            <div className="meta-grid">
              <Info label="프로젝트" value={session.project ?? "–"} />
              <Info label="경로" value={session.cwd ?? "–"} mono />
              <Info label="세션 ID" value={session.id} mono />
              <Info label="모델" value={session.model ?? "–"} mono />
              <Info label="추론 수준" value={meta.reasoningEffort ? reasoningLabel(meta.reasoningEffort) : "기본"} />
              <Info label="브랜치" value={session.gitBranch ?? "–"} mono />
              <Info label="메시지" value={messageCount?.toLocaleString() ?? "–"} />
              <Info label="토큰" value={formatTokens(session.tokenTotal)} />
              <Info label="파일" value={formatBytes(session.sizeBytes)} />
              <Info label="요청일시" value={formatDate(session.startedAt)} />
              <Info label="업데이트" value={formatDate(session.updatedAt)} />
            </div>
          </section>
        </div>}
        <div className="drawer-tabs" role="tablist" aria-label="세션 상세 보기">
          <button className={activeTab === "conversation" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "conversation"} onClick={() => setActiveTab("conversation")}><MessagesSquare size={13} aria-hidden="true" /><span>대화</span></button>
          <button className={activeTab === "activity" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "activity"} onClick={() => setActiveTab("activity")}><ScrollText size={13} aria-hidden="true" /><span>작업 로그</span></button>
          <button className={activeTab === "terminal" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "terminal"} onClick={() => setActiveTab("terminal")}><SquareTerminal size={13} aria-hidden="true" /><span>터미널</span></button>
        </div>
      </div>}
      onClose={onClose}
      bodyRef={drawerBodyRef}
      bodyOverlay={activeTab === "conversation" ? <ChatScrollControls
        targetRef={drawerBodyRef}
        onScrollAwayFromLatest={pauseFollowingLatestMessages}
        onScrollToLatest={resumeFollowingLatestMessages}
      /> : undefined}
      footer={activeTab === "conversation" ? <>{pendingApprovals.length > 0 && <div className="chat-approval-dock" aria-label="응답을 기다리는 권한 요청"><header><strong>권한 승인 대기</strong><span>선택할 때까지 에이전트 작업이 일시 정지됩니다.</span></header>{pendingApprovals.map((prompt) => <ChatApprovalCard prompt={prompt} onDecision={decideContinuation} key={prompt.id} />)}</div>}<SessionContinuationComposer
        value={continuationText}
        attachments={continuationAttachments}
        uploading={continuationUploading}
        source={session.source}
        mode={continuationMode}
        approvalMode={continuationApprovalMode}
        model={continuationModel}
        modelOptions={continuationModelOptions}
        reasoningEffort={continuationReasoningEffort}
        reasoningOptions={continuationReasoningOptions}
        settingFields={settingFieldsFor(providerOptions, session.source)}
        extraSettings={continuationExtraSettings}
        phase={continuationPhase}
        queue={continuationQueue}
        blockedReason={!session.cwd
          ? "작업 경로가 없어 이어갈 수 없습니다"
          : session.isSubagent
            ? "서브에이전트 세션은 이어갈 수 없습니다"
            : null}
        error={continuationError}
        onChange={setContinuationText}
        onAddFiles={addContinuationFiles}
        onRemoveAttachment={removeContinuationAttachment}
        onModeChange={(mode) => void changeContinuationMode(mode)}
        onApprovalModeChange={(mode) => void changeContinuationApprovalMode(mode)}
        onModelChange={(model) => void changeContinuationModel(model)}
        onReasoningEffortChange={(effort) => void changeContinuationReasoningEffort(effort)}
        onExtraSettingsApply={(settings) => void changeContinuationExtraSettings(settings)}
        onSettingsOpen={() => {
          void refreshProviderOptions(session.source).catch((cause) => {
            setContinuationError(`최신 실행 설정을 불러오지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
          });
        }}
        onSubmit={sendContinuation}
        onQueue={() => void deliverContinuation(false)}
        onSteer={() => void deliverContinuation(true)}
        onInterrupt={interruptContinuation}
        onRemoveQueued={(messageId) => void removeContinuationQueued(messageId)}
        onRecallQueued={(item) => void recallContinuationQueued(item)}
      /></> : undefined}
    >
      {activeTab === "terminal" ? (
        <TerminalPanel session={session} />
      ) : <>
      {error && <ErrorBanner message={error} />}
      <section className={`transcript-section transcript-section-${activeTab}`}>
        <div className="section-title">
          <h3>{activeTab === "activity" ? "작업 로그" : "대화 내역"}</h3>
          <span>
            {detail ? `${detail.transcript.length.toLocaleString()}개 항목` : ""}
            {detail?.truncated ? " · 이전 항목 생략" : ""}
            {detail && detail.skippedLines > 0 ? ` · 읽지 못한 줄 ${detail.skippedLines.toLocaleString()}개` : ""}
          </span>
        </div>
        {!detail && !error ? (
          <LoadingState label="대화 원문을 읽고 있습니다" />
        ) : detail?.unavailableReason ? (
          <EmptyState title="본문을 열 수 없습니다" detail={detail.unavailableReason} />
        ) : detail?.transcript.length === 0 ? (
          <EmptyState title="표시할 대화가 없습니다" />
        ) : (
          <>
            {earlierLoadCount > 0 && (
              <div className="transcript-load-earlier">
                <button
                  className="button compact"
                  type="button"
                  disabled={loadingEarlier}
                  onClick={() => void loadEarlierTranscript()}
                >
                  <History size={13} aria-hidden="true" />
                  <span>{loadingEarlier ? "이전 대화를 불러오는 중…" : "이전 대화 더보기"}</span>
                </button>
                {earlierError && <small className="transcript-load-earlier-error" role="alert">{earlierError}</small>}
              </div>
            )}
            <TranscriptTurns items={detail?.transcript ?? []} mode={activeTab === "activity" ? "activity" : "conversation"} onOpenLocalLink={linkedFilePreview.open} />
          </>
        )}
      </section>
      {activeTab === "conversation" && continuationTurns.length > 0 && (
        <section className="session-continuation-stream" aria-live="polite">
          <div className="section-title"><h3>이어지는 대화</h3><span>현재 연결</span></div>
          {continuationTurns.map((turn) => <ChatConversationTurn
            turn={turn}
            chatId={continuationRef.current?.info.chatId ?? attachChatId}
            className="session-continuation-turn"
            onDecision={decideContinuation}
            onOpenLocalLink={linkedFilePreview.open}
            key={turn.id}
          />)}
        </section>
      )}
      </>}
    </Drawer>
    {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </>
  );
}

function readSessionTranscriptLimit(): SessionTranscriptLimit {
  if (typeof window === "undefined") return DEFAULT_SESSION_TRANSCRIPT_LIMIT;
  try {
    const stored = window.localStorage.getItem(SESSION_TRANSCRIPT_LIMIT_KEY) as SessionTranscriptLimit | null;
    return stored && SESSION_TRANSCRIPT_LIMITS.includes(stored)
      ? stored
      : DEFAULT_SESSION_TRANSCRIPT_LIMIT;
  } catch {
    return DEFAULT_SESSION_TRANSCRIPT_LIMIT;
  }
}

function SessionContinuationComposer({
  value,
  attachments,
  uploading,
  source,
  mode,
  approvalMode,
  model,
  modelOptions,
  reasoningEffort,
  reasoningOptions,
  settingFields,
  extraSettings,
  phase,
  queue,
  blockedReason,
  error,
  onChange,
  onAddFiles,
  onRemoveAttachment,
  onModeChange,
  onApprovalModeChange,
  onModelChange,
  onReasoningEffortChange,
  onExtraSettingsApply,
  onSettingsOpen,
  onSubmit,
  onQueue,
  onSteer,
  onInterrupt,
  onRemoveQueued,
  onRecallQueued,
}: {
  value: string;
  attachments: ChatAttachmentDraft[];
  uploading: boolean;
  source: ProviderId;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  modelOptions: ChatModelCatalogOption[];
  reasoningEffort: ReasoningEffort | "";
  reasoningOptions: ChatReasoningOption[];
  settingFields: ChatSettingField[];
  extraSettings: Record<string, string>;
  phase: ChatPhase | "idle" | "connecting";
  queue: QueuedChatMessage[];
  blockedReason: string | null;
  error: string | null;
  onChange: (value: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (draft: ChatAttachmentDraft) => void;
  onModeChange: (mode: ChatMode) => void;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | "") => void;
  onExtraSettingsApply: (settings: Record<string, string>) => void;
  onSettingsOpen: () => void;
  onSubmit: (event: FormEvent) => void;
  onQueue: () => void;
  onSteer: () => void;
  onInterrupt: () => void;
  onRemoveQueued: (messageId: string) => void;
  onRecallQueued: (item: QueuedChatMessage) => void;
}) {
  const busy = phase === "running" || phase === "waitingApproval";
  const modeLocked = busy || phase === "connecting";
  const canCompose = !blockedReason && phase !== "connecting" && !uploading;
  const placeholder = blockedReason
    ?? (phase === "connecting"
      ? "기존 대화에 연결하고 있습니다"
      : phase === "running"
        ? "응답 중입니다. 지금 보내면 대기열에 추가됩니다"
        : phase === "waitingApproval"
          ? "승인 대기 중입니다. 지금 보내면 대기열에 추가됩니다"
          : "이 세션에 이어서 메시지를 입력한 뒤 전송 버튼을 누르세요");
  return (
    <div className="session-continuation-footer">
      <ChatRuntimeSettingsMenu
        panelId="session-runtime-settings-panel"
        contextLabel="이어가기"
        source={source}
        mode={mode}
        approvalMode={approvalMode}
        model={model}
        modelOptions={modelOptions}
        reasoningEffort={reasoningEffort}
        reasoningOptions={reasoningOptions}
        settingFields={settingFields}
        extraSettings={extraSettings}
        locked={modeLocked}
        statusIndicator={<span className={`terminal-status terminal-status-${phase}`} />}
        statusLabel={blockedReason
          ? <small>{blockedReason}</small>
          : <small>{continuationPhaseLabel(phase)}</small>}
        onOpen={onSettingsOpen}
        onModeChange={onModeChange}
        onApprovalModeChange={onApprovalModeChange}
        onModelChange={onModelChange}
        onReasoningEffortChange={onReasoningEffortChange}
        onExtraSettingsApply={onExtraSettingsApply}
      />
      {error && <ErrorBanner message={error} />}
      <ChatComposer
        className="session-chat-composer"
        ariaLabel="세션 대화 이어가기"
        value={value}
        attachments={attachments}
        uploading={uploading}
        busy={busy}
        canCompose={canCompose}
        rows={1}
        placeholder={placeholder}
        queue={queue}
        onChange={onChange}
        onAddFiles={onAddFiles}
        onRemoveAttachment={onRemoveAttachment}
        onSubmit={onSubmit}
        onQueue={onQueue}
        onSteer={onSteer}
        onInterrupt={onInterrupt}
        onRemoveQueued={onRemoveQueued}
        onRecallQueued={onRecallQueued}
      />
    </div>
  );
}

function continuationPhaseLabel(phase: ChatPhase | "idle" | "connecting"): string {
  if (phase === "idle") return "입력 대기";
  if (phase === "connecting") return "기존 세션 연결 중";
  if (phase === "ready") return "입력 대기";
  if (phase === "running") return "응답 중";
  if (phase === "waitingApproval") return "승인 대기";
  if (phase === "stopped") return "연결 종료";
  return "연결 오류";
}

// 트랜스크립트는 수백 개 항목을 그리므로, 상위 폴링·연결 상태 변화에 딸려 재조정되지 않도록 memo한다.
const TranscriptTurns = memo(function TranscriptTurns({ items, mode, onOpenLocalLink }: { items: TranscriptItem[]; mode: "conversation" | "activity"; onOpenLocalLink: (href: string) => void }) {
  const turns = useMemo(() => groupTranscriptTurns(items), [items]);
  return (
    <div className="transcript-list transcript-turn-list">
      {turns.map((turn) => {
        const conversationItems = turn.items.filter((item) => item.blocks.some(isConversationBlock));
        const activityItems = turn.items.filter((item) => item.blocks.some(isActivityBlock));
        const conversationActivityItems = turn.items.filter((item) => item.blocks.some(isConversationActivityBlock));
        const lastAssistantItem = [...conversationItems].reverse().find((item) => item.role === "assistant");
        if (mode === "activity") {
          if (activityItems.length === 0) return null;
          const activityStatus = transcriptActivityStatus(activityItems);
          return <section className="transcript-turn activity-turn" key={turn.id}>
            <header><span className={`chat-tool-state chat-tool-state-${activityStatus}`} /><strong>{turn.title}</strong><time>{transcriptActivityStatusLabel(activityStatus)} · {formatDate(turn.startedAt)}</time></header>
            <div>{activityItems.map((item) => <TranscriptArticle item={item} blocks="activity" onOpenLocalLink={onOpenLocalLink} key={item.index} />)}</div>
          </section>;
        }
        return <section className="transcript-turn conversation-turn" key={turn.id}>
          {conversationItems.filter((item) => item.role === "user").map((item) => <TranscriptArticle item={item} blocks="conversation" onOpenLocalLink={onOpenLocalLink} key={item.index} />)}
          {conversationActivityItems.length > 0 && <ConversationActivitySummary items={conversationActivityItems} onOpenLocalLink={onOpenLocalLink} />}
          {conversationItems.filter((item) => item.role !== "user").map((item) => <TranscriptArticle item={item} blocks="conversation" speechReady={item === lastAssistantItem} onOpenLocalLink={onOpenLocalLink} key={item.index} />)}
        </section>;
      })}
    </div>
  );
});

function ConversationActivitySummary({ items, onOpenLocalLink }: { items: TranscriptItem[]; onOpenLocalLink: (href: string) => void }) {
  const status = transcriptActivityStatus(items);
  return <ChatActivityGroup
    entries={items}
    active={false}
    status={status}
    statusText={transcriptActivityStatusLabel(status)}
    summary={transcriptActivitySummary(items)}
    entryKey={(item) => String(item.index)}
    renderEntry={(item) => <TranscriptArticle item={item} blocks="operational" onOpenLocalLink={onOpenLocalLink} />}
  />;
}

const TranscriptArticle = memo(function TranscriptArticle({ item, blocks, speechReady = false, onOpenLocalLink }: { item: TranscriptItem; blocks: "conversation" | "activity" | "operational"; speechReady?: boolean; onOpenLocalLink: (href: string) => void }) {
  const visible = item.blocks.filter(blocks === "conversation" ? isConversationBlock : blocks === "operational" ? isConversationActivityBlock : isActivityBlock);
  if (visible.length === 0) return null;
  const toolEvent = visible.every((block) => block.kind === "tool_use" || block.kind === "tool_result");
  const sessionInfoEvent = visible.some((block) => block.kind === "session_info");
  const reasoningEvent = visible.every((block) => block.kind === "thinking");
  const contextEvent = visible.every((block) => block.kind === "context" || block.kind === "raw");
  const messageKind = sessionInfoEvent ? "session-info" : toolEvent ? "tool-event" : reasoningEvent ? "reasoning" : contextEvent ? "context" : item.role;
  const roleLabel = item.role === "user" ? "사용자 요청" : item.role === "assistant" ? "에이전트 응답" : item.typeLabel ?? roleName(item.role);
  const messageLabel = sessionInfoEvent
    ? "세션 정보"
    : toolEvent
      ? "도구 실행"
      : reasoningEvent
        ? "진행 상황"
        : contextEvent
          ? item.typeLabel ?? "런타임 컨텍스트"
          : roleLabel;
  const copyText = item.role === "assistant" && blocks === "conversation"
    ? joinMarkdownBlocks(visible.flatMap((block) => block.kind === "text" ? [block.text] : []))
    : "";
  if (toolEvent) {
    return <div className="transcript-tool-sequence">{visible.map((block, index) => <BlockView block={block} onOpenLocalLink={onOpenLocalLink} key={index} />)}</div>;
  }
  return (
    <article className={`message message-${messageKind}`}>
      <header><strong>{messageLabel}</strong><span>{item.model ?? ""}</span><time>{formatDate(item.timestamp)}</time></header>
      {copyText && speechReady && <SpeechPlaybackAction responseId={`session:${item.index}:${item.timestamp ?? "unknown"}`} text={copyText} />}
      {copyText && <CopyAction value={copyText} kind="response" className="message-copy-action" />}
      {visible.map((block, index) => <BlockView block={block} copyable={Boolean(copyText)} onOpenLocalLink={onOpenLocalLink} key={index} />)}
      {item.usage && <footer>입력 {formatTokens(item.usage.input)} · 출력 {formatTokens(item.usage.output)} · 캐시 {formatTokens(item.usage.cacheRead + item.usage.cacheWrite)}</footer>}
    </article>
  );
});

function groupTranscriptTurns(items: TranscriptItem[]): { id: string; title: string; startedAt: number | null; items: TranscriptItem[] }[] {
  const turns: { id: string; title: string; startedAt: number | null; items: TranscriptItem[] }[] = [];
  for (const item of items) {
    const userText = item.role === "user"
      ? item.blocks.find((block): block is Extract<ContentBlock, { kind: "text" }> => block.kind === "text")?.text
      : null;
    if (userText || turns.length === 0) {
      turns.push({ id: item.turnId ?? `turn-${item.index}`, title: userText?.replace(/\s+/g, " ").slice(0, 90) ?? "세션 정보", startedAt: item.timestamp, items: [] });
    }
    turns[turns.length - 1].items.push(item);
  }
  return turns;
}

function isConversationBlock(block: ContentBlock): boolean {
  return block.kind === "text";
}

function isActivityBlock(block: ContentBlock): boolean {
  return block.kind === "context" || block.kind === "thinking" || block.kind === "tool_use" || block.kind === "tool_result" || block.kind === "session_info" || block.kind === "raw";
}

function isConversationActivityBlock(block: ContentBlock): boolean {
  return block.kind === "thinking" || block.kind === "tool_use" || block.kind === "tool_result";
}

function transcriptActivitySummary(items: TranscriptItem[]): string {
  const blocks = items.flatMap((item) => item.blocks);
  const tools = Math.max(
    blocks.filter((block) => block.kind === "tool_use").length,
    blocks.filter((block) => block.kind === "tool_result").length,
  );
  const reasoning = blocks.filter((block) => block.kind === "thinking").length;
  const contexts = blocks.filter((block) => block.kind === "context" || block.kind === "session_info" || block.kind === "raw").length;
  return [tools ? `도구 ${tools}개` : "", reasoning ? `진행 상황 ${reasoning}개` : "", contexts ? `컨텍스트 ${contexts}개` : ""].filter(Boolean).join(" · ") || "작업 로그";
}

function transcriptActivityStatus(items: TranscriptItem[]): "completed" | "failed" {
  return items.some((item) => item.blocks.some((block) => block.kind === "tool_result" && block.isError)) ? "failed" : "completed";
}

function transcriptActivityStatusLabel(status: "completed" | "failed"): string {
  return status === "failed" ? "도구 실패 포함" : "응답 종료";
}

const BlockView = memo(function BlockView({ block, copyable = false, onOpenLocalLink }: { block: ContentBlock; copyable?: boolean; onOpenLocalLink: (href: string) => void }) {
  if (block.kind === "session_info") return <SessionInfoBlock block={block} />;
  if (block.kind === "context") return <details className="block context-block transcript-disclosure"><summary><strong>{block.label}</strong><span>{toolPreview(block.text)} · {inlineSize(block.text)}</span></summary><pre>{block.text}</pre></details>;
  if (block.kind === "tool_use") {
    return <ChatToolCard name={block.name} status="completed" detail={block.inputJson} />;
  }
  if (block.kind === "tool_result") {
    return <ChatToolCard name={block.isError ? "도구 오류" : "도구 결과"} status={block.isError ? "failed" : "completed"} output={block.text} />;
  }
  if (block.kind === "thinking") return <details className="block thinking-block"><summary>추론</summary><pre>{block.text}</pre></details>;
  if (block.kind === "raw") return <details className="block raw-block transcript-disclosure"><summary><strong>원본 이벤트</strong><span>{inlineSize(block.json)}</span></summary><pre>{block.json}</pre></details>;
  return <div className="block text-block text-block-markdown"><MarkdownPreview source={block.text} compact copyable={copyable} onOpenLocalLink={onOpenLocalLink} /></div>;
});

function SessionInfoBlock({ block }: { block: Extract<ContentBlock, { kind: "session_info" }> }) {
  const fields = [
    ["세션 ID", block.id],
    ["작업 경로", block.cwd],
    ["실행 클라이언트", block.originator],
    ["CLI 버전", block.cliVersion],
    ["입력 소스", block.source],
    ["모델 공급자", block.modelProvider],
    ["스레드 종류", block.threadSource],
    ["기록 방식", block.historyMode],
    ["컨텍스트 ID", block.contextWindowId],
    ["등록 도구", `${block.toolCount.toLocaleString()}개`],
  ].filter((field): field is [string, string] => Boolean(field[1]));

  return (
    <div className="session-info-block">
      <div className="session-info-grid">
        {fields.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong title={value}>{value}</strong></div>
        ))}
      </div>
      <details className="session-info-raw transcript-disclosure">
        <summary>
          <strong>원본 메타데이터</strong>
          <span>{inlineSize(block.rawJson)}{block.rawTruncated ? " · 일부 생략" : ""}</span>
        </summary>
        <pre>{block.rawJson}</pre>
      </details>
    </div>
  );
}

function toolPreview(text: string): string {
  if (!text) return "";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const preview = value.file_path ?? value.path ?? value.command ?? value.cmd ?? value.query;
    if (typeof preview === "string") return preview;
  } catch { /* Plain tool output is summarized below. */ }
  return text.replace(/\s+/g, " ").slice(0, 72);
}

function inlineSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function conversationMessageCount(detail: SessionDetail | null): number | null {
  if (!detail) return null;
  return detail.transcript.filter((item) =>
    (item.role === "user" || item.role === "assistant")
    && item.blocks.some((block) => block.kind === "text")
  ).length;
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><span>{label}</span><strong className={mono ? "mono" : ""} title={value}>{value}</strong></div>;
}

function roleName(role: string): string {
  if (role === "user") return "사용자";
  if (role === "assistant") return "에이전트";
  if (role === "system") return "시스템";
  return "메타";
}
