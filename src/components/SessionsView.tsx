import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleDashed, Eye, EyeOff, ExternalLink, Folder, GripVertical, LayoutGrid, MessagesSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, ScrollText, SlidersHorizontal, SquareTerminal, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { attachChat, connectChat, removeChatInputFile, supportsDeliveryDuringTurn, type ChatConnection } from "../lib/chat";
import { BACKEND_RESTARTED_MESSAGE, ChatRejectedError } from "../lib/chatReconnect";
import {
  createSessionFolder,
  deleteSessionFolder,
  reorderSessionFolder,
  downloadSessionLinkedFile,
  getDetachedChatForSession,
  getProviderAccounts,
  getSessionLinkedFile,
  hasTauriRuntime,
  openProviderSessionApp,
  patchSessionMeta,
  updateSessionFolder,
} from "../lib/ipc";
import { formatBytes, formatDate, formatRelative, formatTokens, sourceName } from "../lib/format";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import { openPopoutWindow, usePopoutWindowTitle } from "../lib/popoutWindow";
import { catalogHealthNotice } from "../lib/catalogHealth";
import { displayUsageWindows, governingUsageWindows } from "../lib/accountUsage";
import type {
  CatalogHealth,
  ChatApprovalMode,
  ChatApprovalDecision,
  ChatEvent,
  ChatMode,
  ChatModelCatalogOption,
  ChatPhase,
  ChatReasoningOption,
  MessageDisplayMode,
  ModelOption,
  ProviderAccountView,
  ProviderId,
  ProviderStatus,
  QueuedChatMessage,
  ReasoningEffort,
  SessionDetail,
  SessionFolder,
  SessionMeta,
  SessionSummary,
  SessionTranscriptLimit,
} from "../types";
import { reasoningOptionsFor, refreshProviderOptions, useProviderOptions } from "../lib/providerOptions";
import { recentModelsFor } from "../lib/recentModels";
import {
  canAddChildFolder,
  folderFilterShows,
  folderParentOptions,
  folderPathLabel,
  folderSubtreeIds,
  hiddenByFolders,
  hiddenFolderIds,
  recountSessionFolders,
  ROOT_FOLDER_VALUE,
  visibleFolderSubtreeIds,
} from "../lib/sessionFolders";
import { defaultApprovalMode, normalizeExtraSettings, normalizeSettingValue, permissionModeLabel, reasoningLabel, sameChatSettings, settingFieldsFor, type ChatSettingField } from "../lib/chatSettings";
import { liveStreamBoundaryMs, transcriptBeforeLiveStream } from "../lib/transcriptOverlap";
import { planExecutionRequest } from "../lib/planRestart";
import { buildSessionHandoffMessage } from "../lib/sessionHandoff";
import { optimisticSessionMeta } from "../lib/sessionMeta";
import { orderSessionsForList } from "../lib/sessionList";
import { sessionFailureTitle } from "../lib/sessionFailure";
import {
  ActivityFilterSelect,
  TranscriptLimitSelect,
  TranscriptLoadEarlier,
  TranscriptTurns,
  useSessionTranscript,
} from "./SessionTranscript";
import type { ActivityFilter } from "../lib/activityFilter";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { ChatApprovalDock, ChatContextMeter, Drawer, EmptyState, ErrorBanner, LoadingState, SourceBadge, useConfirm, useEscapeToClose } from "./Shared";
import { TerminalPanel } from "./TerminalPanel";
import { ChatRuntimeSettingsMenu } from "./ChatRuntimeSettingsMenu";
import {
  appendAttachmentDrafts,
  queuedAttachmentsToDrafts,
  uploadAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { ChatComposer } from "./ChatComposer";
import {
  applyChatEvent,
  ChatConversationTurn,
  ChatScrollControls,
  lastUserMessageKey,
  scrollToLastUserMessage,
  type ChatEntry,
  type ChatTurn,
} from "./ChatConversation";
import { readSecondaryPaneOpen, writeSecondaryPaneOpen } from "../lib/secondaryPane";

interface SessionsProps {
  providers: ProviderStatus[];
  sessions: SessionSummary[];
  folders: SessionFolder[];
  selected: SessionSummary | null;
  messageDisplayMode: MessageDisplayMode;
  /** 세션·채팅이 함께 쓰는 대화 내역 표시 범위. 소유는 App에 있다. */
  transcriptLimit: SessionTranscriptLimit;
  onTranscriptLimitChange: (limit: SessionTranscriptLimit) => void;
  onSelect: (session: SessionSummary | null) => void;
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void;
  onFoldersChanged: (folders: SessionFolder[], deletedFolderIds?: string[]) => void;
  onSessionCatalogChanged: (source: ProviderId, id: string) => Promise<void>;
  attentionTarget: SessionAttentionTarget | null;
  onAttentionTargetHandled: (target: SessionAttentionTarget, opened: boolean) => void;
  /** 목록 갱신 상태. 목록이 멈췄는지는 세션 배열만 봐서는 알 수 없다. */
  catalogHealth?: CatalogHealth | null;
  onRefreshList?: () => void;
  /** 이 화면이 이미 팝아웃 창일 때는 '새 창으로 열기'를 다시 제공하지 않는다. */
  popout?: boolean;
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
type SessionContextMenuState = { source: ProviderId; id: string; x: number; y: number };

/** 목록 검색 조건. 필터와 '가려졌는지' 판정이 같은 규칙을 쓰도록 한곳에 둔다. */
function matchesSessionQuery(session: SessionSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [session.title, session.project, session.cwd, session.id, session.meta.note]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(needle));
}

/** 한 번에 그리는 세션 행 수. '더 보기'로 이 단위만큼 늘린다. */
// 목록을 좁히는 축은 한 벌로 묶어 둔다. 축이 하나 늘 때마다 상태 선언·걸러내기·되돌리기·
// 렌더 구간 초기화 네 자리를 같이 고쳐야 했고, 한 자리만 빠뜨리면 "필터를 바꿨는데 목록이
// 옛 구간에 멈춘다" 같은 어긋남이 생겼다.
interface SessionListFilters {
  query: string;
  source: ProviderId | "all";
  project: string;
  favoritesOnly: boolean;
  showHidden: boolean;
  failuresOnly: boolean;
  includeArchived: boolean;
  includeSubagents: boolean;
  includeAia: boolean;
}

const DEFAULT_SESSION_LIST_FILTERS: SessionListFilters = {
  query: "",
  source: "all",
  project: "all",
  favoritesOnly: false,
  showHidden: false,
  failuresOnly: false,
  includeArchived: false,
  includeSubagents: false,
  // AIA와 나눈 대화도 기본으로 보여 준다. 잦은 시스템 대화를 잠시 접어 두고 싶을 때만 끈다.
  includeAia: true,
};

// 폴더 조건만 뺀 걸러내기. 폴더 사이드바 개수를 이 조건으로 세어야 "미분류 98건"을 눌렀는데
// 숨김·보관·서브에이전트로 걸러져 목록이 0건이 되는 어긋남이 생기지 않는다.
function sessionMatchesListFilters(session: SessionSummary, filters: SessionListFilters): boolean {
  if (filters.source !== "all" && session.source !== filters.source) return false;
  if (filters.project !== "all" && session.cwd !== filters.project) return false;
  if (!filters.showHidden && session.meta.hidden) return false;
  if (filters.showHidden && !session.meta.hidden) return false;
  if (!filters.includeArchived && session.archived) return false;
  if (!filters.includeSubagents && session.isSubagent) return false;
  if (!filters.includeAia && session.aiaWorkspace) return false;
  if (filters.favoritesOnly && !session.meta.favorite) return false;
  if (filters.failuresOnly && !session.lastFailure) return false;
  return matchesSessionQuery(session, filters.query);
}

// 바깥에서 연 세션이 지금 필터에 걸려 있을 때, 그 세션이 걸리는 축만 골라 되돌린다.
function revealedListFilters(filters: SessionListFilters, session: SessionSummary): SessionListFilters {
  return {
    query: matchesSessionQuery(session, filters.query) ? filters.query : "",
    source: filters.source === "all" || filters.source === session.source ? filters.source : "all",
    project: filters.project === "all" || filters.project === session.cwd ? filters.project : "all",
    favoritesOnly: filters.favoritesOnly && !session.meta.favorite ? false : filters.favoritesOnly,
    showHidden: session.meta.hidden,
    failuresOnly: filters.failuresOnly && !session.lastFailure ? false : filters.failuresOnly,
    includeArchived: filters.includeArchived || !session.archived ? filters.includeArchived : true,
    includeSubagents: filters.includeSubagents || !session.isSubagent ? filters.includeSubagents : true,
    includeAia: filters.includeAia || !session.aiaWorkspace ? filters.includeAia : true,
  };
}

const SESSION_RENDER_PAGE = 100;
const SESSION_FOLDER_PANE_OPEN_KEY = "agent-manager.session-folder-pane";

interface SessionFolderDrag {
  /** 끌고 있는 세션. 끌기 판정을 넘기기 전에는 null이라 행 강조·미리보기가 뜨지 않는다. */
  draggedSession: SessionSummary | null;
  /** 커서를 따라다니는 미리보기 자리. */
  previewPoint: { x: number; y: number } | null;
  /** 지금 커서 아래에 있는 폴더 드롭 대상 id(`unfiled` 포함). */
  dropTarget: string | null;
  /** 행의 pointerdown에서 끌기를 걸어 둔다. 실제 끌기는 문턱을 넘어야 시작된다. */
  armDrag: (session: SessionSummary, event: ReactPointerEvent<HTMLElement>) => void;
  /** 끌기로 끝난 pointerup이 만든 click이면 삼키고 true를 돌려준다. */
  swallowsClick: () => boolean;
}

/**
 * 세션 행을 폴더로 끌어다 담는 조작. 창 전역 포인터 이벤트를 듣고, 문턱(6px)을 넘은
 * 뒤에야 끌기로 보고, 놓은 자리의 `data-folder-drop-id`에 세션을 담는다. 목록 화면의
 * 본문에서 이 관심사만 떼어내 두어, 화면은 결과 네 값과 행 핸들러 둘만 쓴다.
 */
function useSessionFolderDrag(assignToFolder: (session: SessionSummary, folderId: string | null) => Promise<void>): SessionFolderDrag {
  const [draggedSession, setDraggedSession] = useState<SessionSummary | null>(null);
  const [previewPoint, setPreviewPoint] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const pointerDragRef = useRef<{ session: SessionSummary; startX: number; startY: number; active: boolean } | null>(null);
  const suppressNextClickRef = useRef(false);

  useEffect(() => {
    const targetAt = (event: PointerEvent): string | null =>
      document.elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-folder-drop-id]")
        ?.dataset.folderDropId ?? null;
    const clear = () => {
      pointerDragRef.current = null;
      setDraggedSession(null);
      setPreviewPoint(null);
      setDropTarget(null);
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
      setPreviewPoint({ x: event.clientX, y: event.clientY });
      setDropTarget(targetAt(event));
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

  const armDrag = useCallback((session: SessionSummary, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // Touch/pen scrolls cancel row drags anyway (preventDefault on pointermove
    // cannot stop panning), so arming them here only janks the first scroll
    // frames. Touch drags start from the grip, which opts out via touch-action.
    if (event.pointerType !== "mouse" && !(event.target as Element).closest?.(".drag-grip")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = { session, startX: event.clientX, startY: event.clientY, active: false };
  }, []);

  const swallowsClick = useCallback(() => {
    if (!suppressNextClickRef.current) return false;
    suppressNextClickRef.current = false;
    return true;
  }, []);

  return { draggedSession, previewPoint, dropTarget, armDrag, swallowsClick };
}

export function SessionsView({ providers, sessions, folders, selected, messageDisplayMode, transcriptLimit, onTranscriptLimitChange, onSelect, onMetaChanged, onFoldersChanged, onSessionCatalogChanged, attentionTarget, onAttentionTargetHandled, catalogHealth = null, onRefreshList, popout = false }: SessionsProps) {
  // 마지막 요청이 한도 초과·오류로 끝난 세션만 추려 보는 failuresOnly는 되돌릴 대화를 찾는
  // 흐름이라 즐겨찾기·보관함과 같은 '좁히기' 칩으로 묶여 있다.
  const [filters, setFilters] = useState<SessionListFilters>(DEFAULT_SESSION_LIST_FILTERS);
  const { query, source, project, favoritesOnly, showHidden, failuresOnly, includeArchived, includeSubagents, includeAia } = filters;
  const patchFilters = useCallback((patch: Partial<SessionListFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const moreFiltersRef = useRef<HTMLDivElement | null>(null);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [folderPaneOpen, setFolderPaneOpen] = useState(() => readSecondaryPaneOpen(SESSION_FOLDER_PANE_OPEN_KEY));
  const folderPaneCloseRef = useRef<HTMLButtonElement>(null);
  const folderPaneRestoreRef = useRef<HTMLButtonElement>(null);
  const folderPaneFocusTargetRef = useRef<"close" | "restore" | null>(null);
  const handleAttentionAttach = useCallback((opened: boolean) => {
    if (attentionTarget) onAttentionTargetHandled(attentionTarget, opened);
  }, [attentionTarget, onAttentionTargetHandled]);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);

  const setFolderPaneVisibility = (open: boolean) => {
    folderPaneFocusTargetRef.current = open ? "close" : "restore";
    setFolderPaneOpen(open);
  };

  useEffect(() => writeSecondaryPaneOpen(SESSION_FOLDER_PANE_OPEN_KEY, folderPaneOpen), [folderPaneOpen]);
  useLayoutEffect(() => {
    const target = folderPaneFocusTargetRef.current;
    if (!target) return;
    folderPaneFocusTargetRef.current = null;
    if (target === "close") folderPaneCloseRef.current?.focus();
    else folderPaneRestoreRef.current?.focus();
  }, [folderPaneOpen]);

  // 추가 필터는 툴바 위에 떠 있는 팝오버다. 바깥 클릭·Esc로 닫아 목록 조작을 막지 않는다.
  useEscapeToClose(() => setMoreFiltersOpen(false), moreFiltersOpen);
  useEffect(() => {
    if (!moreFiltersOpen) return undefined;
    const closeOutside = (event: PointerEvent) => {
      if (!moreFiltersRef.current?.contains(event.target as Node)) setMoreFiltersOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [moreFiltersOpen]);

  // 접혀 있을 때도 무엇이 걸려 있는지 알 수 있게, 기본값과 다른 항목 수를 칩에 적는다.
  const adjustedMoreFilters = [includeArchived, includeSubagents, !includeAia].filter(Boolean).length;

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

  // 상위 폴더를 골랐을 때 함께 볼 하위 폴더. 숨긴 하위 폴더는 여기서 빠지고, 숨긴
  // 폴더 자신을 골랐을 때만 그 안이 열린다.
  const folderSubtree = useMemo(() => (
    folderFilter === "all" || folderFilter === "unfiled" ? null : visibleFolderSubtreeIds(folders, folderFilter)
  ), [folders, folderFilter]);
  const hiddenFolders = useMemo(() => hiddenFolderIds(folders), [folders]);

  const folderScoped = useMemo(
    () => sessions.filter((session) => sessionMatchesListFilters(session, filters)),
    [sessions, filters],
  );

  // 즐겨찾기를 앞으로 올린 뒤 잘라 낸다. 정렬을 렌더 구간 뒤에 두면 별표를 단 오래된
  // 세션이 '더 보기'를 몇 번 누른 뒤에야 나타난다.
  const filtered = useMemo(() => orderSessionsForList(folderScoped.filter((session) => {
    if (folderFilter === "unfiled" && session.meta.folderIds.length > 0) return false;
    // 숨긴 폴더에만 담긴 세션은 전체 목록에서 뺀다. 보이는 폴더에도 담겨 있으면 그
    // 폴더에서 계속 봐야 하므로 남긴다.
    if (folderFilter === "all" && hiddenByFolders(session.meta.folderIds, hiddenFolders)) return false;
    // 상위 폴더를 고르면 하위 폴더에 담긴 세션까지 함께 본다.
    if (folderSubtree && !session.meta.folderIds.some((folderId) => folderSubtree.has(folderId))) return false;
    return true;
  })), [folderScoped, folderFilter, folderSubtree, hiddenFolders]);
  // 접힌 패널의 복원 버튼 라벨. 접근성 이름은 현재 폴더를 끼워 넣은 문장이라 정적 치환기가
  // 통째로 대응할 수 없으므로(QA #19), 언어별 문장을 여기서 완성해 넘긴다.
  const { text } = useI18n();
  const selectedFolderName = folderFilter === "all" || folderFilter === "unfiled"
    ? null
    : folders.find((folder) => folder.id === folderFilter)?.name ?? null;
  const collapsedFolderLabel = folderFilter === "unfiled"
    ? text("미분류", "Unfiled")
    : selectedFolderName ?? text("폴더", "Folders");
  const collapsedFolderRestoreLabel = folderFilter === "unfiled"
    ? text("세션 폴더 보기 · 현재 미분류", "Show session folders · current: Unfiled")
    : selectedFolderName
      ? text(`세션 폴더 보기 · 현재 ${selectedFolderName}`, `Show session folders · current: ${selectedFolderName}`)
      : text("세션 폴더 보기 · 현재 폴더", "Show session folders · current: Folders");

  // 787건 규모에서 전체 행을 매 렌더마다 그리면 원격 웹(특히 모바일)이 눌린다.
  // 필터와 검색은 전체 목록으로 계산하고, 실제로 그리는 행 수만 늘려 간다.
  const [renderLimit, setRenderLimit] = useState(SESSION_RENDER_PAGE);
  useEffect(() => { setRenderLimit(SESSION_RENDER_PAGE); }, [filters, folderFilter]);
  const visible = useMemo(() => filtered.slice(0, renderLimit), [filtered, renderLimit]);

  // 반복 요청 실행 이력·알림·대시보드에서 연 세션은 지금 필터에 걸려 목록에 없을 수 있다.
  // 특히 반복 회차 세션은 숨긴 '반복 요청' 폴더에만 담겨 전체 목록에서 빠지므로, 선택만
  // 풀어 버리면 "열기를 눌렀는데 아무 것도 안 열린다"가 된다. 그 세션이 걸리는 필터만
  // 골라 되돌려 목록에도 함께 보이게 한다.
  const revealSession = useCallback((session: SessionSummary) => {
    setFilters((current) => revealedListFilters(current, session));
    setFolderFilter((current) => {
      const folderIds = session.meta.folderIds;
      if (folderFilterShows(folders, current, folderIds)) return current;
      // 전체 목록에 나오는 세션이면 폴더를 좁히지 않고 전체로 돌아간다. 숨긴 폴더에만
      // 담긴 세션은 그 폴더를 직접 골라야만 보이므로 그때만 폴더를 바꾼다.
      if (folderFilterShows(folders, "all", folderIds)) return "all";
      return folderIds[0] ?? "all";
    });
  }, [folders]);

  // 선택된 세션이 목록에 없을 때의 처리. 목록에 한 번 올라온 뒤(settled) 사라졌다면
  // 사용자가 필터를 바꾼 것이므로 상세를 닫고, 바깥에서 막 연 세션이라면 필터를 푼다.
  // 필터를 풀고도 안 보이면(카탈로그에서 사라진 세션 등) 상세는 그대로 열어 둔다.
  const selectionRef = useRef<{ key: string; settled: boolean } | null>(null);
  useEffect(() => {
    if (!selected) {
      selectionRef.current = null;
      return;
    }
    const key = `${selected.source}:${selected.id}`;
    const visibleInList = filtered.some((session) => (
      session.source === selected.source && session.id === selected.id
    ));
    if (visibleInList) {
      selectionRef.current = { key, settled: true };
      return;
    }
    const tracked = selectionRef.current?.key === key ? selectionRef.current : null;
    if (tracked?.settled) {
      onSelect(null);
      return;
    }
    if (tracked) return;
    selectionRef.current = { key, settled: false };
    revealSession(selected);
  }, [filtered, onSelect, revealSession, selected]);

  // 메타 수정은 서버 왕복 위에 메타데이터 파일을 통째로 다시 쓰는 작업이 얹힌다. 그것을
  // 기다린 뒤에 화면을 바꾸면 별표나 보관 토글이 누른 뒤에도 한참 예전 상태로 남는다.
  // 화면을 먼저 바꾸고, 서버가 거절하면 이전 값으로 되돌린다.
  const patchListSessionMeta = useCallback(async (session: SessionSummary, patch: Partial<SessionMeta>) => {
    setFolderError(null);
    const previous = session.meta;
    onMetaChanged(session.source, session.id, optimisticSessionMeta(previous, patch));
    try {
      const meta = await patchSessionMeta(session.source, session.id, patch);
      onMetaChanged(session.source, session.id, meta);
      return true;
    } catch (cause) {
      onMetaChanged(session.source, session.id, previous);
      setFolderError(errorText(cause));
      return false;
    }
  }, [onMetaChanged]);

  const assignToFolder = useCallback(async (session: SessionSummary, folderId: string | null) => {
    const folderIds = folderId === null ? [] : session.meta.folderIds.includes(folderId)
      ? session.meta.folderIds
      : [...session.meta.folderIds, folderId];
    if (folderIds.length === session.meta.folderIds.length && folderIds.every((id, index) => id === session.meta.folderIds[index])) return;
    await patchListSessionMeta(session, { folderIds });
  }, [patchListSessionMeta]);

  const contextSession = contextMenu
    ? sessions.find((session) => session.source === contextMenu.source && session.id === contextMenu.id) ?? null
    : null;

  useEffect(() => {
    if (contextMenu && !contextSession) setContextMenu(null);
  }, [contextMenu, contextSession]);

  const runContextMetaAction = useCallback(async (session: SessionSummary, patch: Partial<SessionMeta>) => {
    setContextMenu(null);
    await patchListSessionMeta(session, patch);
  }, [patchListSessionMeta]);

  const { draggedSession, previewPoint, dropTarget, armDrag, swallowsClick } = useSessionFolderDrag(assignToFolder);

  // 팝아웃 창 제목으로 어떤 세션을 띄운 창인지 구분한다.
  usePopoutWindowTitle(popout && selected ? selected.title : null);

  const sessionDetail = selected ? (
    <SessionDrawer
      key={`${selected.source}:${selected.id}`}
      providers={providers}
      sessions={sessions}
      session={selected}
      folders={folders}
      messageDisplayMode={messageDisplayMode}
      transcriptLimit={transcriptLimit}
      onClose={() => onSelect(null)}
      onMetaChanged={onMetaChanged}
      onSessionCatalogChanged={onSessionCatalogChanged}
      onOpenRelatedSession={onSelect}
      onTranscriptLimitChange={onTranscriptLimitChange}
      attachChatId={attentionTarget?.source === selected.source && attentionTarget.sessionId === selected.id ? attentionTarget.chatId : null}
      attachRequestId={attentionTarget?.requestId ?? 0}
      onAttachHandled={handleAttentionAttach}
      popout={popout}
    />
  ) : null;

  // 팝아웃 창은 이 세션 하나를 위한 창이다. 목록·폴더·필터는 본 창의 몫이므로 상세만 그린다.
  if (popout) {
    return <div className="session-popout">{sessionDetail ?? <LoadingState label="세션을 여는 중…" />}</div>;
  }

  return (
    <div className={`sessions-layout${folderPaneOpen ? "" : " folders-closed"}`}>
      {folderPaneOpen && <SessionFolderSidebar
        sessions={sessions}
        scopedSessions={folderScoped}
        folders={folders}
        active={folderFilter}
        draggedSession={draggedSession}
        dropTarget={dropTarget}
        onSelect={setFolderFilter}
        onFoldersChanged={onFoldersChanged}
        onClose={() => setFolderPaneVisibility(false)}
        closeButtonRef={folderPaneCloseRef}
      />}
      {draggedSession && previewPoint && <div className="session-drag-preview" style={{ left: previewPoint.x + 14, top: previewPoint.y + 14 }} aria-hidden="true"><span className="drag-preview-grip"><GripVertical size={14} /></span><SourceBadge source={draggedSession.source} /><strong>{draggedSession.title}</strong></div>}
      <div className="session-list-pane">
      {folderError && <ErrorBanner message={folderError} />}
      <CatalogHealthBanner health={catalogHealth} onRefresh={onRefreshList} />
      <section className="toolbar-card">
        {!folderPaneOpen && <button ref={folderPaneRestoreRef} className="secondary-pane-restore" type="button" data-ui-anchor="sessions.folders" onClick={() => setFolderPaneVisibility(true)} aria-label={collapsedFolderRestoreLabel} title={collapsedFolderRestoreLabel} aria-expanded={false}><PanelLeftOpen size={15} /><span>{collapsedFolderLabel}</span></button>}
        <div className="source-tabs">
          {(["all", "claude", "codex", "antigravity"] as const).map((item) => (
            <button
              className={source === item ? "active" : ""}
              key={item}
              type="button"
              onClick={() => patchFilters({ source: item })}
            >
              {item === "all" ? "전체" : sourceName(item)}
            </button>
          ))}
        </div>
        <input
          className="search-input"
          value={query}
          onChange={(event) => patchFilters({ query: event.target.value })}
          placeholder="제목·프로젝트·ID·메모 검색"
        />
        <select value={project} onChange={(event) => patchFilters({ project: event.target.value })}>
          <option value="all">프로젝트 전체</option>
          {projects.map(([path, item]) => (
            <option value={path} key={path}>{item.name} ({item.count})</option>
          ))}
        </select>
        {/* 목록을 좁히는 조건은 칩 한 묶음으로 모은다. 체크박스로 흩어 두면 좁은 화면에서
            줄바꿈이 제각각 끊겨 어떤 조건이 걸려 있는지 한눈에 읽히지 않는다. */}
        <div className="filter-chips" role="group" aria-label="세션 좁히기">
          <button
            className={favoritesOnly ? "filter-chip active" : "filter-chip"}
            type="button"
            aria-pressed={favoritesOnly}
            title="별표를 단 세션만 봅니다"
            onClick={() => patchFilters({ favoritesOnly: !favoritesOnly })}
          >
            <Star size={12} fill={favoritesOnly ? "currentColor" : "none"} aria-hidden="true" />
            <span>즐겨찾기</span>
          </button>
          <button
            className={showHidden ? "filter-chip active" : "filter-chip"}
            type="button"
            aria-pressed={showHidden}
            title="보관함으로 옮긴 세션만 봅니다"
            onClick={() => patchFilters({ showHidden: !showHidden })}
          >
            <Archive size={12} aria-hidden="true" />
            <span>보관함</span>
          </button>
          <button
            className={failuresOnly ? "filter-chip danger active" : "filter-chip danger"}
            type="button"
            aria-pressed={failuresOnly}
            title="마지막 요청이 한도 초과·오류로 끝난 세션만 봅니다"
            onClick={() => patchFilters({ failuresOnly: !failuresOnly })}
          >
            <TriangleAlert size={12} aria-hidden="true" />
            <span>실패</span>
          </button>
        </div>
        <div className="more-filter" ref={moreFiltersRef}>
          <button
            className={`more-filter-trigger${moreFiltersOpen ? " active" : ""}${adjustedMoreFilters > 0 ? " adjusted" : ""}`}
            type="button"
            aria-expanded={moreFiltersOpen}
            aria-controls="session-more-filter-panel"
            title="보관·서브에이전트·AIA 대화 포함 여부"
            onClick={() => setMoreFiltersOpen((current) => !current)}
          >
            <SlidersHorizontal size={13} aria-hidden="true" />
            <span>추가 필터</span>
            {adjustedMoreFilters > 0 && <em aria-label={`기본값과 다른 항목 ${adjustedMoreFilters}개`}>{adjustedMoreFilters}</em>}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {moreFiltersOpen && (
            <div className="more-filter-panel" id="session-more-filter-panel" role="group" aria-label="추가 필터">
              <label className="check-filter"><input type="checkbox" checked={includeArchived} onChange={(event) => patchFilters({ includeArchived: event.target.checked })} /> 공급자 보관 세션 포함</label>
              <label className="check-filter"><input type="checkbox" checked={includeSubagents} onChange={(event) => patchFilters({ includeSubagents: event.target.checked })} /> 서브에이전트 포함</label>
              <label className="check-filter"><input type="checkbox" checked={includeAia} onChange={(event) => patchFilters({ includeAia: event.target.checked })} /> AIA 대화 포함</label>
            </div>
          )}
        </div>
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
                {visible.map((session) => (
                  <tr
                    className={draggedSession?.source === session.source && draggedSession.id === session.id ? "is-dragging" : ""}
                    key={`${session.source}:${session.id}`}
                    onContextMenu={(event) => {
                      // Shift+우클릭은 WebView의 Reload/Inspect 메뉴가 필요한 개발 흐름에 남겨 둔다.
                      if (event.shiftKey) return;
                      event.preventDefault();
                      const row = event.currentTarget.getBoundingClientRect();
                      setMoreFiltersOpen(false);
                      setContextMenu({
                        source: session.source,
                        id: session.id,
                        x: event.clientX || row.left + 24,
                        y: event.clientY || row.top + 24,
                      });
                    }}
                    onClick={() => { if (!swallowsClick()) onSelect(session); }}
                    onPointerDown={(event: ReactPointerEvent<HTMLTableRowElement>) => armDrag(session, event)}
                  >
                    <td><span className="session-source-cell"><span className="drag-grip" title="폴더로 드래그"><GripVertical size={13} /></span><SourceBadge source={session.source} /></span></td>
                    <td>
                      <div className="title-cell">
                        <strong>{session.meta.favorite && <span className="favorite-star"><Star size={11} fill="currentColor" strokeWidth={0} /></span>}{session.aiaWorkspace && <span className="session-aia-chip" title="AIA 작업공간에서 오간 대화입니다">AIA</span>}{session.lastFailure && <span className="session-failure-chip" title={sessionFailureTitle(session.lastFailure)}>실패</span>}{session.title}</strong>
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
            {visible.length < filtered.length && (
              <div className="session-table-more">
                <button className="button" type="button" onClick={() => setRenderLimit((current) => current + SESSION_RENDER_PAGE)}>
                  더 보기 · {visible.length} / {filtered.length}
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      </div>

      {contextMenu && contextSession && <SessionContextMenu
        session={contextSession}
        folders={folders}
        anchorX={contextMenu.x}
        anchorY={contextMenu.y}
        onClose={() => setContextMenu(null)}
        onOpen={() => {
          setContextMenu(null);
          onSelect(contextSession);
        }}
        onOpenPopout={() => {
          setContextMenu(null);
          void openPopoutWindow({ kind: "session", source: contextSession.source, sessionId: contextSession.id })
            .catch((cause: unknown) => setFolderError(errorText(cause)));
        }}
        onToggleFavorite={() => runContextMetaAction(contextSession, { favorite: !contextSession.meta.favorite })}
        onChooseFolder={(folderId) => {
          const folderIds = folderId === null
            ? []
            : contextSession.meta.folderIds.includes(folderId)
              ? contextSession.meta.folderIds.filter((id) => id !== folderId)
              : [...contextSession.meta.folderIds, folderId];
          return runContextMetaAction(contextSession, { folderIds });
        }}
        onToggleArchived={() => runContextMetaAction(contextSession, { hidden: !contextSession.meta.hidden })}
      />}

      {sessionDetail}
    </div>
  );
}

interface SessionContextMenuProps {
  session: SessionSummary;
  folders: SessionFolder[];
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  onOpen: () => void;
  onOpenPopout: () => void;
  onToggleFavorite: () => void | Promise<void>;
  onChooseFolder: (folderId: string | null) => void | Promise<void>;
  onToggleArchived: () => void | Promise<void>;
}

function SessionContextMenu({ session, folders, anchorX, anchorY, onClose, onOpen, onOpenPopout, onToggleFavorite, onChooseFolder, onToggleArchived }: SessionContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: anchorX, top: anchorY });
  useEscapeToClose(onClose);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(margin, Math.min(anchorX, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(anchorY, window.innerHeight - rect.height - margin)),
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [anchorX, anchorY]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnOutsideScroll = (event: Event) => {
      const target = event.target;
      // scroll은 버블링하지 않지만 캡처 단계에서는 메뉴 내부 목록의 스크롤도 window에
      // 도달한다. 폴더를 훑는 정상 동작은 유지하고, 뒤쪽 화면이 움직일 때만 닫는다.
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", closeOnOutsideScroll, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", closeOnOutsideScroll, true);
    };
  }, [onClose]);

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return createPortal(
    <div
      className="session-context-menu"
      ref={menuRef}
      role="menu"
      aria-label={`${session.title} 세션 기능`}
      style={{ left: position.left, top: position.top }}
      onKeyDown={moveFocus}
    >
      <header>
        <SourceBadge source={session.source} />
        <strong>{session.title}</strong>
      </header>
      <button type="button" role="menuitem" onClick={onOpen}><ScrollText size={14} /> 세션 열기</button>
      <button type="button" role="menuitem" onClick={onOpenPopout}><AppWindow size={14} /> 새 창으로 열기</button>
      <button type="button" role="menuitem" onClick={onToggleFavorite}>
        <Star size={14} fill={session.meta.favorite ? "currentColor" : "none"} />
        {session.meta.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
      </button>
      <section className="session-context-folders" aria-label="폴더 지정">
        <span><Folder size={13} /> 폴더 지정</span>
        <div onWheel={(event) => event.stopPropagation()}>
          <button className={session.meta.folderIds.length === 0 ? "selected" : ""} type="button" role="menuitemcheckbox" aria-checked={session.meta.folderIds.length === 0} onClick={() => onChooseFolder(null)}>
            <i className="folder-unfiled-dot" /> 미분류
            {session.meta.folderIds.length === 0 && <Check size={12} />}
          </button>
          {folders.map((folder) => {
            const selected = session.meta.folderIds.includes(folder.id);
            return <button
              className={selected ? "selected" : ""}
              style={{ "--folder-color": folder.color } as CSSProperties}
              type="button"
              role="menuitemcheckbox"
              aria-checked={selected}
              title={folderPathLabel(folders, folder.id)}
              key={folder.id}
              onClick={() => onChooseFolder(folder.id)}
            >
              <i /> <span>{folderPathLabel(folders, folder.id)}</span>
              {selected && <Check size={12} />}
            </button>;
          })}
        </div>
      </section>
      <div className="session-context-separator" />
      <button className="archive" type="button" role="menuitem" onClick={onToggleArchived}>
        {session.meta.hidden ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {session.meta.hidden ? "보관 해제" : "보관"}
      </button>
      <small>공급자 세션 원본은 변경하지 않습니다.</small>
    </div>,
    document.body,
  );
}

/**
 * 목록이 언제 기준인지 알리는 배너. 정상이면 아무것도 그리지 않는다.
 *
 * 스냅샷 읽기는 갱신이 멈춰도 성공하므로, 목록만 봐서는 굳었는지 알 수 없다.
 */
function CatalogHealthBanner({ health, onRefresh }: { health: CatalogHealth | null; onRefresh?: () => void }) {
  const notice = catalogHealthNotice(health, Date.now());
  if (!notice) return null;
  return (
    <div className={`catalog-health-banner is-${notice.tone}`} role="status">
      <div>
        <strong>{notice.headline}</strong>
        {notice.detail && <small>{notice.detail}</small>}
      </div>
      {onRefresh && <button className="button secondary" type="button" onClick={onRefresh}>지금 갱신</button>}
    </div>
  );
}

function SessionFolderSidebar({
  sessions,
  scopedSessions,
  folders,
  active,
  draggedSession,
  dropTarget,
  onSelect,
  onFoldersChanged,
  onClose,
  closeButtonRef,
}: {
  sessions: SessionSummary[];
  /** 폴더 조건을 뺀 현재 필터 결과. 배지 개수는 목록과 같은 이 기준으로 센다. */
  scopedSessions: SessionSummary[];
  folders: SessionFolder[];
  active: FolderFilter;
  draggedSession: SessionSummary | null;
  dropTarget: string | null;
  onSelect: (folder: FolderFilter) => void;
  onFoldersChanged: (folders: SessionFolder[], deletedFolderIds?: string[]) => void;
  onClose: () => void;
  closeButtonRef: { current: HTMLButtonElement | null };
}) {
  // 폴더를 만들 때 고른 상위 폴더. `null`은 최상위, 여는 중이 아니면 undefined.
  const [creatingParent, setCreatingParent] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#f0b054");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingColor, setEditingColor] = useState("#f0b054");
  const [editingParent, setEditingParent] = useState(ROOT_FOLDER_VALUE);
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedFolders);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { text } = useI18n();
  // 편집 행은 목록(.folder-list) 안에서 열리는데, 목록 아랫줄 폴더에서는 행이 스크롤 영역
  // 밖으로 자라 안내 푸터 아래에 가린 채 열렸다(QA #44). 행이 그려진 뒤 목록 안으로 끌어온다.
  const editRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (editingId === null) return;
    editRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [editingId]);
  const unfiledCount = scopedSessions.filter((session) => session.meta.folderIds.length === 0).length;
  const unfiledTotal = sessions.filter((session) => session.meta.folderIds.length === 0).length;
  // 전체 세션 배지는 목록과 같은 기준으로 센다. 숨긴 폴더에만 담긴 세션은 목록에서
  // 빠지므로 여기에서도 빠져야 한다.
  const hiddenFolders = useMemo(() => hiddenFolderIds(folders), [folders]);
  const visibleScoped = useMemo(
    () => scopedSessions.filter((session) => !hiddenByFolders(session.meta.folderIds, hiddenFolders)),
    [scopedSessions, hiddenFolders],
  );
  const visibleTotal = useMemo(
    () => sessions.filter((session) => !hiddenByFolders(session.meta.folderIds, hiddenFolders)).length,
    [sessions, hiddenFolders],
  );
  // 폴더 배지도 같은 기준으로 다시 센다. 백엔드 개수는 숨김·보관·서브에이전트까지 포함하므로
  // 필터를 켠 화면에서는 눌러도 비어 있는 개수가 된다.
  const scopedCounts = useMemo(() => {
    const counted = recountSessionFolders(folders, scopedSessions);
    return new Map(counted.map((folder) => [folder.id, folder]));
  }, [folders, scopedSessions]);
  const countHint = (visible: number, total: number) => (
    visible === total ? `${total}건` : `현재 필터로 보이는 ${visible}건 (전체 ${total}건)`
  );

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const folder of folders) {
      if (!folder.parentId) continue;
      counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1);
    }
    return counts;
  }, [folders]);

  // 형제 중 처음·마지막인지. 목록이 트리 순서로 오므로 같은 상위끼리 모으면 그대로 순서다.
  const siblingEdges = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const folder of folders) {
      const key = folder.parentId ?? ROOT_FOLDER_VALUE;
      const bucket = groups.get(key) ?? [];
      bucket.push(folder.id);
      groups.set(key, bucket);
    }
    const edges = new Map<string, { first: boolean; last: boolean }>();
    for (const bucket of groups.values()) {
      bucket.forEach((id, index) => edges.set(id, {
        first: index === 0,
        last: index === bucket.length - 1,
      }));
    }
    return edges;
  }, [folders]);

  // 목록은 트리 순서로 오므로, 접힌 조상을 만난 폴더부터 아래로 함께 감춘다.
  const visibleFolders = useMemo(() => {
    const hiddenParents = new Set<string>();
    return folders.filter((folder) => {
      const parentId = folder.parentId ?? null;
      if (parentId && (hiddenParents.has(parentId) || collapsed.has(parentId))) {
        hiddenParents.add(folder.id);
        return false;
      }
      return true;
    });
  }, [folders, collapsed]);

  const nestableFolders = useMemo(() => folders.filter(canAddChildFolder), [folders]);
  const editingParentOptions = useMemo(
    () => (editingId ? folderParentOptions(folders, editingId) : []),
    [folders, editingId],
  );

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeCollapsedFolders(next);
      return next;
    });
  };

  const expandFolder = (id: string | null) => {
    if (!id) return;
    setCollapsed((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      writeCollapsedFolders(next);
      return next;
    });
  };

  const startCreating = (parentId: string | null) => {
    setCreatingParent(parentId);
    setName("");
    setError(null);
  };

  // 폴더 변경 다섯 갈래가 모두 같은 봉투(busy 표시 · 이전 오류 비우기 · 실패 문구 표시)를
  // 쓴다. 봉투는 여기 한 벌만 두고, 갈래마다 다른 선행 조건은 호출부에 남긴다.
  const runFolderAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const createFolder = async () => {
    if (!name.trim() || busy || creatingParent === undefined) return;
    await runFolderAction(async () => {
      const folder = await createSessionFolder(name, color, creatingParent);
      onFoldersChanged([...folders, folder]);
      expandFolder(creatingParent);
      setName("");
      setCreatingParent(undefined);
      onSelect(folder.id);
    });
  };

  const startEditing = (folder: SessionFolder) => {
    setEditingId(folder.id);
    setEditingName(folder.name);
    setEditingColor(folder.color);
    setEditingParent(folder.parentId ?? ROOT_FOLDER_VALUE);
    setError(null);
  };

  const saveFolder = async (id: string) => {
    if (!editingName.trim() || busy) return;
    await runFolderAction(async () => {
      const parentId = editingParent === ROOT_FOLDER_VALUE ? null : editingParent;
      const updated = await updateSessionFolder(id, { name: editingName, color: editingColor, parentId });
      onFoldersChanged(folders.map((folder) => folder.id === id ? updated : folder));
      expandFolder(parentId);
      setEditingId(null);
    });
  };

  // 숨김은 폴더를 지우지 않고 전체 목록·상위 폴더 집계에서만 뺀다. 보던 폴더를 그대로
  // 두는 것은 의도한 동작이다 — 숨긴 폴더를 직접 누르는 것이 그 안을 보는 길이다.
  const toggleHidden = async (folder: SessionFolder) => {
    if (busy) return;
    await runFolderAction(async () => {
      const updated = await updateSessionFolder(folder.id, { hidden: !folder.hidden });
      onFoldersChanged(folders.map((item) => item.id === folder.id ? updated : item));
    });
  };

  // 순서는 형제 사이에서 한 칸씩 옮긴다. 백엔드가 다시 매긴 목록을 그대로 받아 쓴다.
  const moveFolder = async (folder: SessionFolder, direction: "up" | "down") => {
    if (busy) return;
    await runFolderAction(async () => {
      onFoldersChanged(await reorderSessionFolder(folder.id, direction));
    });
  };

  const removeFolder = async (folder: SessionFolder) => {
    await runFolderAction(async () => {
      const removed = await deleteSessionFolder(folder.id);
      const removedIds = removed.length > 0 ? removed : [folder.id];
      onFoldersChanged(folders.filter((item) => !removedIds.includes(item.id)), removedIds);
      setCollapsed((current) => {
        const next = new Set([...current].filter((id) => !removedIds.includes(id)));
        writeCollapsedFolders(next);
        return next;
      });
      if (removedIds.includes(active)) onSelect("all");
      setDeleteCandidate(null);
    });
  };

  const deleteDescendantCount = deleteCandidate
    ? folderSubtreeIds(folders, deleteCandidate.id).size - 1
    : 0;

  return (
    <aside className="session-folders" id="session-folders" data-ui-anchor="sessions.folders">
      <header>
        <div><strong>폴더</strong><span>{folders.length}</span></div>
        <div className="secondary-pane-header-actions"><button className="folder-add-button" type="button" onClick={() => creatingParent === undefined ? startCreating(null) : setCreatingParent(undefined)} title="최상위 폴더 추가" aria-label="최상위 폴더 추가" aria-expanded={creatingParent !== undefined}><Plus size={15} /></button><button ref={closeButtonRef} className="secondary-pane-toggle" type="button" onClick={onClose} aria-label={text("세션 폴더 숨기기", "Hide session folders")} title={text("세션 폴더 숨기기", "Hide session folders")}><PanelLeftClose size={15} /></button></div>
      </header>
      {creatingParent !== undefined && <div className="folder-create-form">
        <div><input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="폴더 색상" /><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && createFolder()} placeholder="새 폴더 이름" autoFocus /></div>
        <label className="folder-parent-field">
          <span>상위 폴더</span>
          <select value={creatingParent ?? ROOT_FOLDER_VALUE} onChange={(event) => setCreatingParent(event.target.value === ROOT_FOLDER_VALUE ? null : event.target.value)}>
            <option value={ROOT_FOLDER_VALUE}>최상위</option>
            {nestableFolders.map((folder) => <option key={folder.id} value={folder.id}>{folderPathLabel(folders, folder.id)}</option>)}
          </select>
        </label>
        <div><button type="button" onClick={() => setCreatingParent(undefined)}>취소</button><button className="primary" type="button" disabled={!name.trim() || busy} onClick={createFolder}>추가</button></div>
      </div>}
      {deleteCandidate && <div className="folder-delete-confirm" role="alertdialog" aria-label="폴더 삭제 확인">
        <p>
          '{folderPathLabel(folders, deleteCandidate.id)}' 폴더를 삭제할까요?
          {deleteDescendantCount > 0 && ` 하위 폴더 ${deleteDescendantCount}개도 함께 삭제됩니다.`}
          {" 세션과 원본 대화는 삭제되지 않습니다."}
        </p>
        <div><button type="button" disabled={busy} onClick={() => setDeleteCandidate(null)}>취소</button><button className="danger" type="button" disabled={busy} onClick={() => void removeFolder(deleteCandidate)}>{busy ? "삭제 중…" : "삭제"}</button></div>
      </div>}
      {error && <p className="folder-error">{error}</p>}
      <div className="folder-list">
        <button className={active === "all" ? "folder-filter active" : "folder-filter"} type="button" title={countHint(visibleScoped.length, visibleTotal)} onClick={() => onSelect("all")}>
          <span className="folder-symbol all"><LayoutGrid size={14} strokeWidth={1.8} /></span><strong>전체 세션</strong><em>{visibleScoped.length}</em>
        </button>
        <button
          data-folder-drop-id="unfiled"
          className={`${active === "unfiled" ? "folder-filter active" : "folder-filter"}${dropTarget === "unfiled" ? " drop-target" : ""}`}
          type="button"
          title={countHint(unfiledCount, unfiledTotal)}
          onClick={() => onSelect("unfiled")}
        >
          <span className="folder-symbol unfiled"><CircleDashed size={14} /></span><strong>미분류</strong><em>{unfiledCount}</em>
        </button>
        <div className="folder-divider"><span>내 폴더</span>{draggedSession && <em>여기에 놓아 추가</em>}</div>
        {visibleFolders.map((folder) => {
          const childCount = childCounts.get(folder.id) ?? 0;
          const edge = siblingEdges.get(folder.id);
          const isCollapsed = collapsed.has(folder.id);
          const scoped = scopedCounts.get(folder.id);
          const sessionCount = scoped?.sessionCount ?? 0;
          const nestedSessionCount = (scoped?.totalSessionCount ?? 0) - sessionCount;
          return editingId === folder.id ? (
            <div className="folder-edit-row" ref={editRowRef} style={{ "--folder-depth": folder.depth } as CSSProperties} key={folder.id}>
              <input type="color" value={editingColor} onChange={(event) => setEditingColor(event.target.value)} aria-label="폴더 색상" />
              <input value={editingName} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void saveFolder(folder.id); if (event.key === "Escape") setEditingId(null); }} autoFocus />
              <button type="button" title="저장" aria-label="이름·색상 저장" disabled={busy || !editingName.trim()} onClick={() => saveFolder(folder.id)}><Check size={13} /></button>
              <button type="button" title="닫기" aria-label="폴더 편집 닫기" onClick={() => setEditingId(null)}><X size={13} /></button>
              <select value={editingParent} onChange={(event) => setEditingParent(event.target.value)} aria-label="상위 폴더">
                <option value={ROOT_FOLDER_VALUE}>최상위</option>
                {editingParentOptions.map((option) => <option key={option.id} value={option.id}>{folderPathLabel(folders, option.id)}</option>)}
              </select>
              <div className="folder-edit-actions">
                <button type="button" title="위로 이동" aria-label={`${folder.name} 폴더를 위로 이동`} disabled={busy || !edge || edge.first} onClick={() => void moveFolder(folder, "up")}><ArrowUp size={12} /></button>
                <button type="button" title="아래로 이동" aria-label={`${folder.name} 폴더를 아래로 이동`} disabled={busy || !edge || edge.last} onClick={() => void moveFolder(folder, "down")}><ArrowDown size={12} /></button>
                <button
                  type="button"
                  title={folder.hidden ? "표시 · 전체 세션과 상위 폴더에 다시 넣기" : "숨김 · 전체 세션과 상위 폴더에서 빼고 이 폴더에서만 보기"}
                  aria-label={folder.hidden ? `${folder.name} 폴더 표시` : `${folder.name} 폴더 숨김`}
                  aria-pressed={folder.hidden}
                  disabled={busy}
                  onClick={() => void toggleHidden(folder)}
                >
                  {folder.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
                </button>
                {canAddChildFolder(folder) && <button type="button" title="하위 폴더 추가" onClick={() => { setEditingId(null); startCreating(folder.id); }}><Plus size={12} /></button>}
                <button className="danger" type="button" title="폴더 삭제" onClick={() => setDeleteCandidate(folder)}><Trash2 size={12} /></button>
              </div>
            </div>
          ) : (
            <div
              data-folder-drop-id={folder.id}
              className={`${active === folder.id ? "folder-entry active" : "folder-entry"}${dropTarget === folder.id ? " drop-target" : ""}${folder.hidden ? " hidden-folder" : ""}`}
              style={{ "--folder-depth": folder.depth } as CSSProperties}
              key={folder.id}
            >
              {childCount > 0 ? (
                <button
                  className="folder-twisty"
                  type="button"
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? `하위 폴더 ${childCount}개 펼치기` : "하위 폴더 접기"}
                  onClick={() => toggleCollapsed(folder.id)}
                >
                  {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : <span className="folder-twisty" aria-hidden="true" />}
              <button className="folder-entry-main" type="button" onClick={() => onSelect(folder.id)} title={`${folderPathLabel(folders, folder.id)} · ${countHint(sessionCount, folder.sessionCount)}${folder.hidden ? " · 숨긴 폴더 — 전체 세션과 상위 폴더에서 빠집니다" : ""}`}>
                <span className="folder-symbol" style={{ "--folder-color": folder.color } as CSSProperties}>{folder.hidden ? <EyeOff size={13} /> : <Folder size={13} fill="currentColor" strokeWidth={0} />}</span>
                <strong>{folder.name}</strong>
                <em>{sessionCount}{nestedSessionCount > 0 && <i title={`하위 폴더 세션 ${nestedSessionCount}건`}>+{nestedSessionCount}</i>}</em>
              </button>
              <div className="folder-entry-actions">
                <button type="button" title="폴더 편집 · 이름·색상·위치·순서·숨김·삭제" aria-label={`${folder.name} 폴더 편집`} onClick={() => startEditing(folder)}><Pencil size={12} /></button>
              </div>
            </div>
          );
        })}
      </div>
      <footer>
        <span><GripVertical size={13} /></span> 세션 행을 폴더로 드래그하세요.
      </footer>
    </aside>
  );
}

const SESSION_FOLDER_COLLAPSED_KEY = "agent-manager.session-folders-collapsed";

/** 반복 실행이 소유한 런타임에서 실행을 끊는 조작을 막을 때 보여 줄 이유. */
const UNATTENDED_RUNTIME_LOCK_MESSAGE =
  "반복 실행이 이 세션을 사용 중입니다. 실행 설정과 공급자는 이 실행이 끝난 뒤에 바꿀 수 있습니다.";

/** 이어보내기 실행을 다시 띄우게 만드는 설정 다섯 칸. 이 벌이 같으면 실행도 그대로 둔다. */
interface ContinuationSettings {
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  extraSettings: Record<string, string>;
}

function defaultContinuationSettings(source: ProviderId): ContinuationSettings {
  return {
    mode: "workspace",
    approvalMode: defaultApprovalMode(source),
    model: "",
    reasoningEffort: "",
    extraSettings: {},
  };
}

function sameContinuationSettings(a: ContinuationSettings, b: ContinuationSettings): boolean {
  return a.mode === b.mode
    && a.approvalMode === b.approvalMode
    && a.model === b.model
    && a.reasoningEffort === b.reasoningEffort
    && sameChatSettings(a.extraSettings, b.extraSettings);
}

function readCollapsedFolders(): Set<string> {
  try {
    const stored = window.localStorage.getItem(SESSION_FOLDER_COLLAPSED_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedFolders(collapsed: Set<string>) {
  try {
    window.localStorage.setItem(SESSION_FOLDER_COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    // 접힘 상태는 화면 편의값이라 저장에 실패해도 이번 실행 동안만 유지한다.
  }
}

function SessionDrawer({
  providers,
  sessions,
  session,
  folders,
  messageDisplayMode,
  transcriptLimit,
  onClose,
  onMetaChanged,
  onSessionCatalogChanged,
  onOpenRelatedSession,
  onTranscriptLimitChange,
  attachChatId,
  attachRequestId,
  onAttachHandled,
  popout,
}: {
  providers: ProviderStatus[];
  sessions: SessionSummary[];
  session: SessionSummary;
  folders: SessionFolder[];
  messageDisplayMode: MessageDisplayMode;
  transcriptLimit: SessionTranscriptLimit;
  onClose: () => void;
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void;
  onSessionCatalogChanged: (source: ProviderId, id: string) => Promise<void>;
  onOpenRelatedSession: (session: SessionSummary) => void;
  onTranscriptLimitChange: (limit: SessionTranscriptLimit) => void;
  attachChatId: string | null;
  attachRequestId: number;
  onAttachHandled: (opened: boolean) => void;
  popout: boolean;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(session.meta.customTitle ?? "");
  const [note, setNote] = useState(session.meta.note ?? "");
  const [saving, setSaving] = useState(false);
  // 낙관 갱신한 메타를 뒤늦게 도착한 앞선 요청의 응답이 되돌리지 못하게 하는 세대 번호.
  const metaRevision = useRef(0);
  const [openingProviderApp, setOpeningProviderApp] = useState(false);
  const [meta, setMeta] = useState(session.meta);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"conversation" | "activity" | "terminal">("conversation");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [continuationText, setContinuationText] = useState("");
  const [continuationAttachments, setContinuationAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [continuationUploading, setContinuationUploading] = useState(false);
  const [continuationSource, setContinuationSource] = useState<ProviderId>(session.source);
  // 같은 공급자로도 새 세션에 인계할 수 있다. 컨텍스트가 찬 세션은 재개보다 넘기는 편이
  // 나은데, 그러자고 공급자까지 바꿀 이유는 없다. 공급자가 다르면 세션 ID를 공유할 수
  // 없어 인계가 유일한 길이므로, 그때는 이 선택과 무관하게 인계로 간다.
  const [continuationHandoff, setContinuationHandoff] = useState(false);
  // 이어가기 실행 설정 다섯 칸은 언제나 함께 읽히고 함께 갈린다(재연결이 알려준 값으로
  // 덮기, 공급자 교체 시 기본값으로 되돌리기, 변경 실패 시 이전 값으로 되돌리기). 칸마다
  // 상태를 따로 두면 그 세 갈래가 매번 다섯 줄로 늘어나므로 한 벌로 들고 다닌다.
  const [continuationSettings, setContinuationSettings] = useState<ContinuationSettings>(() => ({
    mode: session.meta.mode ?? "workspace",
    approvalMode: session.meta.approvalMode ?? defaultApprovalMode(session.source),
    model: session.model ?? "",
    reasoningEffort: session.meta.reasoningEffort ?? "",
    extraSettings: {},
  }));
  const {
    mode: continuationMode,
    approvalMode: continuationApprovalMode,
    model: continuationModel,
    reasoningEffort: continuationReasoningEffort,
    extraSettings: continuationExtraSettings,
  } = continuationSettings;
  const [continuationPhase, setContinuationPhase] = useState<ChatPhase | "idle" | "connecting">("idle");
  const [continuationContext, setContinuationContext] = useState<{ used: number | null; window: number | null }>({ used: null, window: null });
  const [continuationTurns, setContinuationTurns] = useState<ChatTurn[]>([]);
  const [continuationQueue, setContinuationQueue] = useState<QueuedChatMessage[]>([]);
  const [continuationError, setContinuationError] = useState<string | null>(null);
  // 붙은 실행이 반복 요청이 소유한 unattended 런타임인지. 이 런타임은 스케줄러가
  // 결과를 기다리고 있으므로, 화면이 임의로 멈추거나 갈아 끼우면 그 회차가 통째로
  // 사라진다. 진행 상태는 그대로 보여 주되 실행을 끊는 조작만 막는다.
  const [continuationUnattended, setContinuationUnattended] = useState(false);
  useEffect(() => setMeta(session.meta), [session.meta]);
  // Antigravity처럼 세션 색인에 작업 경로가 없는 공급자는 실행 중 채팅에 붙고 나서야
  // 경로를 알 수 있다. 붙은 실행이 알려준 경로를 기억해 이어가기 입력을 열어 둔다.
  const [attachedCwd, setAttachedCwd] = useState<string | null>(null);
  // 실행 계정 고정 선택에 쓰는 이 공급자의 계정 목록. 세션 설정을 펼칠 때만 읽는다.
  const [providerAccounts, setProviderAccounts] = useState<ProviderAccountView[] | null>(null);
  const drawerBodyRef = useRef<HTMLDivElement>(null);
  const settingsPanelRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  const initialPositionAppliedRef = useRef(false);
  const followLatestMessagesRef = useRef(messageDisplayMode === "latest");
  const handledContinuationUserMessageRef = useRef<string | null>(null);
  const continuationRef = useRef<ChatConnection | null>(null);
  const continuationAttachmentsRef = useRef<ChatAttachmentDraft[]>([]);
  const continuationGenerationRef = useRef(0);
  /** 이 연결에서 실제 state 이벤트를 반영한 세대. attach 응답의 낡은 스냅숏을 가려낸다. */
  const appliedContinuationStateGenerationRef = useRef(-1);
  const continuationActiveTurnRef = useRef<string | null>(null);
  const syncedContinuationSessionsRef = useRef(new Set<string>());
  const loadLinkedFile = useCallback(
    (href: string) => getSessionLinkedFile(session.source, session.id, href),
    [session.id, session.source],
  );
  const downloadLinkedFile = useCallback(
    (href: string) => downloadSessionLinkedFile(session.source, session.id, href),
    [session.id, session.source],
  );
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);
  const providerOptions = useProviderOptions(continuationSource);
  const continuationRecentModels = useMemo(
    () => recentModelsFor(sessions, continuationSource),
    [continuationSource, sessions],
  );
  const continuationModelOptions = providerOptions?.models ?? [];
  const continuationReasoningOptions = reasoningOptionsFor(providerOptions, continuationModel);
  const continuationSettingFields = useMemo(
    () => settingFieldsFor(providerOptions, continuationSource),
    [continuationSource, providerOptions],
  );

  // 세션 메타에 저장된 권한·승인 값이 최신 CLI 스키마에서 사라졌으면 안전한 값으로
  // 되돌린다. 이어가기는 새 실행이므로 지원하지 않는 값으로 시작하면 안 된다.
  useEffect(() => {
    setContinuationSettings((current) => {
      const next: ContinuationSettings = {
        ...current,
        mode: normalizeSettingValue(continuationSettingFields, "mode", current.mode) as ChatMode,
        approvalMode: normalizeSettingValue(continuationSettingFields, "approvalMode", current.approvalMode) as ChatApprovalMode,
        extraSettings: normalizeExtraSettings(continuationSettingFields, current.extraSettings),
      };
      return sameContinuationSettings(current, next) ? current : next;
    });
  }, [continuationSettingFields]);

  const handleContinuationEvent = useCallback((event: ChatEvent, generation: number) => {
    if (generation !== continuationGenerationRef.current) return;
    applyChatEvent(event, {
      activeTurnRef: continuationActiveTurnRef,
      setTurns: setContinuationTurns,
      setQueue: setContinuationQueue,
      onState: (info) => {
        appliedContinuationStateGenerationRef.current = generation;
        setContinuationPhase(info.state);
        setContinuationUnattended(info.unattended);
        setContinuationSettings((current) => ({ ...current, extraSettings: info.settings ?? {} }));
        setContinuationContext({ used: info.contextUsedTokens, window: info.contextWindowTokens });
        if (info.providerSessionId) {
          const key = `${info.source}:${info.providerSessionId}`;
          if (!syncedContinuationSessionsRef.current.has(key)) {
            syncedContinuationSessionsRef.current.add(key);
            void onSessionCatalogChanged(info.source, info.providerSessionId);
          }
        }
        if (info.state === "stopped" || info.state === "failed") {
          setContinuationQueue([]);
          setContinuationUnattended(false);
          const connection = continuationRef.current;
          continuationRef.current = null;
          if (connection) void connection.detach();
        }
      },
      onError: setContinuationError,
    });
  }, [onSessionCatalogChanged]);

  // 대화 원문과 이전 구간 페이징은 채팅 화면과 같은 훅이 맡는다. 여기서는 드로어 본문이
  // 스크롤을 담당하므로 그 요소를 넘겨 이전 구간을 붙인 뒤 위치가 유지되게 한다.
  const {
    detail,
    error: transcriptError,
    loadingEarlier,
    earlierError,
    earlierLoadCount,
    loadEarlier: loadEarlierTranscript,
    refresh: refreshSessionTranscript,
  } = useSessionTranscript({
    source: session.source,
    sessionId: session.id,
    limit: transcriptLimit,
    scrollContainerRef: drawerBodyRef,
  });

  // 재연결 대상 실행이 백엔드 교체로 사라졌다면 원문뿐 아니라 Core가 별도 보관한
  // 중단 기록도 즉시 다시 읽어, 사라진 응답의 이유를 빈 화면 대신 남긴다.
  useEffect(() => {
    if (continuationError === BACKEND_RESTARTED_MESSAGE) refreshSessionTranscript();
  }, [continuationError, refreshSessionTranscript]);

  useEffect(() => {
    initialPositionAppliedRef.current = false;
    handledContinuationUserMessageRef.current = null;
    setError(null);
    setContinuationContext({ used: null, window: null });
  }, [session.source, session.id, transcriptLimit]);

  useEffect(() => {
    setAttachedCwd(null);
  }, [session.source, session.id]);

  useEffect(() => {
    followLatestMessagesRef.current = messageDisplayMode === "latest";
  }, [messageDisplayMode, session.id]);

  const pauseFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = false;
  }, []);
  const resumeFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = messageDisplayMode === "latest";
  }, [messageDisplayMode]);

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
      // 알림은 생성 당시 chatId를 들고 있다. 같은 공급자 세션이 이후 새 런타임으로
      // 이어졌다면 현재 세션 상세의 연결이 더 최신이므로 끊거나 옛 실행으로 되돌리지 않는다.
      setActiveTab("conversation");
      setContinuationError(null);
      if (attachChatId) onAttachHandled(true);
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
      let chatId: string | null = null;
      // 알림 chatId보다 현재 세션에 매핑된 활성 런타임을 우선한다. 알림을 만든 실행이
      // 끝난 뒤 같은 세션이 이어졌다면 옛 실행에 붙어 다시 resume하는 충돌을 막는다.
      for (let attempt = 0; attempt < 4 && !chatId; attempt += 1) {
        const active = await getDetachedChatForSession(session.source, session.id);
        if (cancelled) return null;
        chatId = active?.chatId ?? null;
        if (!chatId && attempt < 3) {
          await new Promise((resolve) => window.setTimeout(resolve, 75));
        }
      }
      chatId ??= attachChatId;
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
          setContinuationUnattended(false);
          return;
        }
        continuationRef.current = connection;
        setAttachedCwd(connection.info.cwd || null);
        setContinuationSettings({
          mode: connection.info.mode,
          approvalMode: connection.info.approvalMode,
          model: connection.info.model ?? "",
          reasoningEffort: connection.info.reasoningEffort ?? "",
          extraSettings: connection.info.settings ?? {},
        });
        setContinuationUnattended(connection.info.unattended);
        // `connection.info`는 백엔드가 리플레이 맨 앞에서 보낸 **첫** state다. 리플레이
        // 끝에 붙는 현재 state를 이미 반영한 뒤라면 과거 상태이므로 덮어쓰지 않는다.
        // 덮어쓰면 응답 중인 세션이 '입력 대기'로 되돌아가 정지 대신 전송 버튼이 뜬다.
        if (appliedContinuationStateGenerationRef.current !== generation) {
          setContinuationPhase(connection.info.state);
        }
        if (attachChatId) onAttachHandled(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setContinuationPhase("idle");
        setContinuationUnattended(false);
        const label = attachChatId ? "알림의 실행" : "기존 CLI 실행";
        setContinuationError(`${label}에 다시 연결하지 못했습니다: ${errorText(cause)}`);
        if (attachChatId) onAttachHandled(false);
      });
    return () => { cancelled = true; };
  }, [attachChatId, attachRequestId, handleContinuationEvent, onAttachHandled, session.id, session.isSubagent, session.source]);

  useEffect(() => {
    if (messageDisplayMode === "start" || initialPositionAppliedRef.current || activeTab !== "conversation" || !detail) return undefined;
    initialPositionAppliedRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const body = drawerBodyRef.current;
      if (!body) return;
      // '마지막 보낸 메시지부터' 모드는 마지막 사용자 메시지를 화면 맨 위에 두고,
      // 사용자 메시지가 없으면(세션 정보만 있는 경우) 맨 아래로 대신 이동한다.
      if (messageDisplayMode === "latest" || !scrollToLastUserMessage(body)) {
        body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, messageDisplayMode, detail]);

  useEffect(() => {
    if (messageDisplayMode !== "latest" || !followLatestMessagesRef.current || activeTab !== "conversation" || continuationTurns.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!followLatestMessagesRef.current) return;
      const body = drawerBodyRef.current;
      if (body) body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, messageDisplayMode, continuationTurns]);

  // '마지막 보낸 메시지부터' 모드: 이어가기 입력으로 새 메시지를 보내면 그 메시지가
  // 화면 맨 위에 오도록 이동한다. 같은 메시지는 다시 이동하지 않는다.
  const continuationLastUserMessageId = useMemo(() => lastUserMessageKey(continuationTurns), [continuationTurns]);
  useEffect(() => {
    if (messageDisplayMode !== "lastUser" || activeTab !== "conversation" || !continuationLastUserMessageId) return undefined;
    if (handledContinuationUserMessageRef.current === continuationLastUserMessageId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (scrollToLastUserMessage(drawerBodyRef.current)) {
        handledContinuationUserMessageRef.current = continuationLastUserMessageId;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTab, messageDisplayMode, continuationLastUserMessageId]);

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

  // 세션 색인에 경로가 없어도 붙은 실행이 알려준 경로로 이어갈 수 있다.
  const continuationCwd = session.cwd ?? attachedCwd;

  // 붙어 있는 실행이 없는 상태. stopped·failed는 상태 이벤트를 받을 때 이미 연결을 놓았다.
  const continuationDetached = continuationPhase === "idle"
    || continuationPhase === "stopped"
    || continuationPhase === "failed";
  /**
   * 다음 전송이 원래 세션 재개가 아니라 새 세션 인계로 나갈지. 붙어 있는 실행이 있으면
   * 그 실행이 이어갈 대상이므로 인계는 다음 시작에만 해당한다.
   */
  const agentHandoffPending = continuationDetached
    && (continuationSource !== session.source || continuationHandoff);

  const pendingApprovals = continuationTurns.flatMap((turn) => turn.entries).filter((entry): entry is Extract<ChatEntry, { type: "approval" }> => entry.type === "approval" && entry.interactive && !entry.resolved);
  const pendingPlanApproval = pendingApprovals.find((entry) => entry.kind === "plan") ?? null;

  /**
   * 이어가기 메시지를 보낸다. `deliverNow`면 응답 중에도 중단 없이 진행 중인 작업에 바로
   * 전달한다.
   *
   * `planRestart`는 사용자가 입력창에 쓴 메시지가 아니라, 계획 승인을 접고 새 권한 범위로
   * 다시 띄우면서 앱이 만들어 보내는 요청이다. 설정 상태는 이 호출을 만든 렌더의 값이라
   * 방금 바꾼 모드를 아직 모르므로, 다시 띄울 모드를 함께 받는다. 입력창의 초안과 첨부는
   * 그대로 둔다 — 사용자가 쓰던 메시지를 앱이 대신 보내거나 지워서는 안 된다.
   */
  const deliverContinuation = async (deliverNow: boolean, planRestart?: { request: string; mode: ChatMode }) => {
    const text = (planRestart?.request ?? continuationText).trim();
    const drafts = planRestart ? [] : continuationAttachmentsRef.current;
    if ((!text && drafts.length === 0) || continuationPhase === "connecting" || continuationUploading) return;
    if (!continuationCwd) {
      setContinuationError("세션에 저장된 작업 경로가 없어 대화를 이어갈 수 없습니다.");
      return;
    }
    if (session.isSubagent) {
      setContinuationError("서브에이전트 세션은 직접 이어가기 대상이 아닙니다.");
      return;
    }
    setContinuationError(null);
    let connection = continuationRef.current;
    const startingAgentHandoff = !connection && (continuationSource !== session.source || continuationHandoff);
    if (!connection) {
      setContinuationPhase("connecting");
      const generation = continuationGenerationRef.current + 1;
      continuationGenerationRef.current = generation;
      try {
        connection = await connectChat({
          source: continuationSource,
          cwd: continuationCwd,
          model: continuationModel || null,
          reasoningEffort: continuationReasoningEffort || null,
          mode: planRestart?.mode ?? continuationMode,
          approvalMode: continuationApprovalMode,
          resumeSessionId: startingAgentHandoff ? null : session.id,
          handoffOrigin: startingAgentHandoff ? { source: session.source, id: session.id } : null,
          unattended: false,
          settings: continuationExtraSettings,
        }, (event) => handleContinuationEvent(event, generation));
        continuationRef.current = connection;
        setAttachedCwd(connection.info.cwd || null);
        setContinuationPhase(connection.info.state);
        // 인계는 한 번의 동작이다. 새 세션이 떴으면 이후 메시지는 그 세션을 이어가야지,
        // 설정 변경으로 연결이 끊길 때마다 또 다른 세션을 만들어서는 안 된다.
        if (startingAgentHandoff) setContinuationHandoff(false);
        if (connection.info.providerSessionId) {
          const key = `${connection.info.source}:${connection.info.providerSessionId}`;
          syncedContinuationSessionsRef.current.add(key);
          void onSessionCatalogChanged(connection.info.source, connection.info.providerSessionId);
        }
      } catch (cause) {
        if (cause instanceof ChatRejectedError
          && cause.code === "sessionBusy"
          && cause.existingChatId) {
          try {
            connection = await attachChat(
              cause.existingChatId,
              (event) => handleContinuationEvent(event, generation),
            );
            continuationRef.current = connection;
            setAttachedCwd(connection.info.cwd || null);
            setContinuationPhase(connection.info.state);
            setContinuationError(null);
          } catch (attachCause) {
            continuationRef.current = null;
            setContinuationPhase("idle");
            setContinuationUnattended(false);
            setContinuationError(errorText(attachCause));
            return;
          }
        } else {
          continuationRef.current = null;
          setContinuationPhase("idle");
          setContinuationUnattended(false);
          setContinuationError(errorText(cause));
          return;
        }
      }
    }
    setContinuationUploading(true);
    try {
      const uploaded = await uploadAttachmentDrafts(connection.info.chatId, drafts, (next) => {
        continuationAttachmentsRef.current = next;
        setContinuationAttachments(next);
      });
      const outgoingText = startingAgentHandoff
        ? buildSessionHandoffMessage({
          source: session.source,
          sessionId: session.id,
          transcript: detail?.transcript ?? [],
          request: text,
        })
        : text;
      await connection.send(outgoingText, {
        steer: deliverNow,
        attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []),
      });
      if (!planRestart) {
        setContinuationText("");
        continuationAttachmentsRef.current = [];
        setContinuationAttachments([]);
      }
    } catch (cause) {
      setContinuationError(errorText(cause));
    } finally {
      setContinuationUploading(false);
    }
  };

  const changeContinuationSource = async (nextSource: ProviderId) => {
    if (nextSource === continuationSource
      || continuationPhase === "connecting"
      || continuationPhase === "running"
      || continuationPhase === "waitingApproval") return;
    // 공급자를 바꾸려면 붙어 있는 실행을 stop()으로 끊어야 한다. 반복 실행이 소유한
    // 런타임을 여기서 끊으면 스케줄러가 기다리던 회차가 결과 없이 사라진다.
    if (continuationUnattended) {
      setContinuationError(UNATTENDED_RUNTIME_LOCK_MESSAGE);
      return;
    }

    const connection = continuationRef.current;
    if (connection) {
      try {
        await connection.stop();
      } catch (cause) {
        setContinuationError(`기존 에이전트 연결을 종료하지 못했습니다: ${errorText(cause)}`);
        return;
      }
      await connection.detach().catch(() => undefined);
    }

    continuationGenerationRef.current += 1;
    continuationRef.current = null;
    setContinuationSource(nextSource);
    setContinuationSettings(defaultContinuationSettings(nextSource));
    setContinuationContext({ used: null, window: null });
    setContinuationTurns([]);
    setContinuationQueue([]);
    setContinuationPhase("idle");
    setContinuationUnattended(false);
    setContinuationError(null);
  };

  const changeContinuationSettings = async (
    next: Partial<ContinuationSettings>,
    label: string,
    options?: { planAbandoned?: boolean },
  ): Promise<boolean> => {
    const previous = continuationSettings;
    const target: ContinuationSettings = { ...previous, ...next };
    if (sameContinuationSettings(target, previous) || continuationPhase === "connecting") return false;
    // 응답 중에 설정을 바꾸면 그 요청이 통째로 사라진다. 기다리던 계획 승인을 이미 취소로
    // 닫은 호출만 예외다 — 그 실행에는 지켜 줄 작업이 남아 있지 않다.
    if (!options?.planAbandoned
      && (continuationPhase === "running" || continuationPhase === "waitingApproval")) return false;

    // 설정 변경은 기존 런타임을 stop()으로 끊고 새로 띄운다. 반복 실행 런타임에는 걸지
    // 않는다 — 화면에서 고른 설정 때문에 예약된 회차가 통째로 날아간다.
    if (continuationUnattended) {
      setContinuationError(UNATTENDED_RUNTIME_LOCK_MESSAGE);
      return false;
    }
    const previousPhase = continuationPhase;
    const connection = continuationRef.current;
    setContinuationSettings(target);
    setContinuationError(null);
    if (!connection) return true;

    setContinuationPhase("connecting");
    try {
      await connection.stop();
    } catch (cause) {
      setContinuationSettings(previous);
      setContinuationPhase(previousPhase);
      setContinuationError(`${label} 변경하지 못했습니다: ${errorText(cause)}`);
      return false;
    }

    continuationGenerationRef.current += 1;
    continuationRef.current = null;
    try { await connection.detach(); } catch { /* The stopped provider process is safe to leave detached. */ }
    setContinuationQueue([]);
    setContinuationPhase("idle");
    setContinuationUnattended(false);
    return true;
  };

  /**
   * 요청 모드를 바꾼다.
   *
   * 평소에는 같은 세션을 새 권한 범위로 다시 열면 끝이다. 계획 승인 중이라면 그 사이에
   * 답을 기다리는 계획이 있는데, 살아 있는 실행에 권한을 더 얹는 길은 승인 응답에 실어
   * 보내는 편집 자동 승인 하나뿐이다. 그보다 넓은 권한으로 이 계획을 실행하려면 접고 다시
   * 띄우는 수밖에 없어, 계획 본문을 새 실행의 첫 요청으로 넘긴다.
   */
  const changeContinuationMode = async (nextMode: ChatMode) => {
    const plan = pendingPlanApproval;
    if (!plan) {
      await changeContinuationSettings({ mode: nextMode }, "요청 모드를");
      return;
    }
    // 계획 모드로 되돌리는 것은 "계획을 다시 세우라"는 뜻이고, 그건 승인 카드의 '계획 다시
    // 세우기'가 할 일이다. 계획을 넘겨받을 실행을 읽기 전용으로 띄우지는 않는다.
    if (nextMode === continuationMode || nextMode === "plan") return;
    const accepted = await confirm({
      title: "요청 모드를 바꿀까요?",
      message: `같은 대화를 ${permissionModeLabel(nextMode)}로 다시 열어 이 계획을 넘깁니다.\n지금 실행은 계획을 승인하지 않고 접히므로 아직 아무것도 실행되지 않습니다.`,
      confirmLabel: "이 계획으로 다시 시작",
    });
    if (!accepted) return;
    const request = planExecutionRequest(plan.detail ?? "", continuationSource);
    // 답을 기다리는 CLI를 그대로 접으면 제어 요청이 미결로 남는다. 승인 전에 취소로 닫는다.
    await decideContinuation(plan.id, "cancel");
    if (!await changeContinuationSettings({ mode: nextMode }, "요청 모드를", { planAbandoned: true })) return;
    await deliverContinuation(false, { request, mode: nextMode });
  };

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

  // 이어보내기 연결을 건드리는 조작은 모두 이전 오류를 비우고 실패만 문구로 남긴다.
  // busy 표시가 없는 것은 의도한 것 — 대기열 조작은 즉시 끝나고 화면을 잠글 이유가 없다.
  const runContinuationAction = async (action: () => Promise<void>) => {
    setContinuationError(null);
    try {
      await action();
    } catch (cause) {
      setContinuationError(errorText(cause));
    }
  };

  const removeContinuationQueued = async (messageId: string) => {
    await runContinuationAction(async () => {
      await continuationRef.current?.removeQueued(messageId);
    });
  };

  const recallContinuationQueued = async (message: QueuedChatMessage) => {
    await runContinuationAction(async () => {
      await continuationRef.current?.removeQueued(message.id);
      setContinuationText((current) => current.trim() ? `${current}\n${message.text}` : message.text);
      const attachments = [...continuationAttachmentsRef.current, ...queuedAttachmentsToDrafts(message.attachments, continuationRef.current?.info.chatId ?? null)];
      continuationAttachmentsRef.current = attachments;
      setContinuationAttachments(attachments);
    });
  };

  const decideContinuation = async (approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>) => {
    await runContinuationAction(async () => {
      await continuationRef.current?.approve(approvalId, decision, answers);
    });
  };

  const interruptContinuation = async () => {
    await runContinuationAction(async () => {
      await continuationRef.current?.interrupt();
    });
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
      setError(errorText(cause));
    } finally {
      setOpeningProviderApp(false);
    }
  };

  const patchMeta = async (patch: Partial<SessionMeta>) => {
    const previous = meta;
    // 별표 같은 토글은 서버 왕복과 메타데이터 파일 쓰기를 기다릴 이유가 없다. 화면을 먼저
    // 바꾸고 요청을 뒤로 보낸다. 연속으로 누르면 응답 순서가 뒤바뀔 수 있어, 마지막 요청의
    // 응답만 반영하고 그 요청이 실패했을 때만 되돌린다.
    metaRevision.current += 1;
    const revision = metaRevision.current;
    const optimistic = optimisticSessionMeta(previous, patch);
    setMeta(optimistic);
    // 목록 행의 별표도 같이 바꿔야 한다. 이 값이 세션 스냅샷을 거쳐 prop으로 돌아오므로,
    // 폴링이 끼어들어도 화면 두 곳이 서로 다른 상태로 갈라지지 않는다.
    onMetaChanged(session.source, session.id, optimistic);
    setSaving(true);
    setError(null);
    try {
      const next = await patchSessionMeta(session.source, session.id, patch);
      if (metaRevision.current !== revision) return;
      setMeta(next);
      onMetaChanged(session.source, session.id, next);
    } catch (cause) {
      if (metaRevision.current !== revision) return;
      setMeta(previous);
      onMetaChanged(session.source, session.id, previous);
      setError(errorText(cause));
    } finally {
      if (metaRevision.current === revision) setSaving(false);
    }
  };
  const messageCount = session.messageCount ?? conversationMessageCount(detail);
  const historicalContextUsedTokens = useMemo(() => {
    const usage = [...(detail?.transcript ?? [])].reverse().find((item) => item.usage)?.usage;
    return usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
  }, [detail]);
  // 파일에 남은 사용량은 원본 세션의 것이다. 붙어 있는 실행이 아직 크기를 알리기 전
  // (압축 직후 포함)에 이 값으로 메우면 남의 세션 크기를 보여 주게 된다.
  const displayedContextUsedTokens = continuationDetached
    ? continuationContext.used ?? historicalContextUsedTokens
    : continuationContext.used;
  /**
   * 컨텍스트가 큰 상태로 계속 밀고 갈 때의 대가를 알린다. CLI가 한계 근처에서 자동
   * 압축을 하므로 대화가 끊기지는 않지만, 압축은 도구 출력과 파일 원문을 요약으로
   * 바꿔 놓고 되돌릴 수 없다. 그래서 "곧 멈춘다"가 아니라 "지금 넘기면 무엇을 고를 수
   * 있는지"를 말한다. 이미 인계를 고른 상태면 권할 것이 없어 띄우지 않는다.
   */
  const largeContextWarning = useMemo(() => {
    if (agentHandoffPending) return null;
    if (continuationContext.used !== null && continuationContext.window !== null
      && continuationContext.window > 0
      && continuationContext.used / continuationContext.window >= 0.8) {
      return `현재 컨텍스트가 ${Math.round((continuationContext.used / continuationContext.window) * 100)}% 사용되었습니다. 한계에 닿으면 CLI가 자동 압축해 도구 출력·파일 원문이 요약으로 대체됩니다. 그 전에 세션 설정의 '새 세션으로 인계'를 쓰면 필요한 문맥만 골라 넘길 수 있습니다.`;
    }
    // 파일에 남은 마지막 사용량은 원본 세션의 것이다. 라이브 실행이 붙어 있으면 그
    // 실행이 이어갈 크기가 아니므로(인계로 갓 만든 새 세션일 수도 있다) 쓰지 않는다.
    if (continuationDetached
      && historicalContextUsedTokens !== null
      && historicalContextUsedTokens >= 600_000) {
      return `최근 입력 컨텍스트가 ${formatTokens(historicalContextUsedTokens)}입니다. 재개하면 이 크기에서 시작해 곧 자동 압축에 닿습니다. 세션 설정의 '새 세션으로 인계'로 넘기는 편이 낫습니다.`;
    }
    return null;
  }, [agentHandoffPending, continuationContext.used, continuationContext.window, continuationDetached, historicalContextUsedTokens]);

  // '이어지는 대화'는 attach 시 백엔드가 리플레이한 과거 이벤트까지 보여 준다.
  // 그 구간은 파일 트랜스크립트에도 이미 남아 있으므로, 라이브가 담당하는 시점부터는
  // 위쪽 대화 내역에서 잘라내 같은 턴이 두 번 보이지 않게 한다.
  const liveStreamBoundary = useMemo(() => liveStreamBoundaryMs(continuationTurns), [continuationTurns]);
  const liveStreamVisible = activeTab === "conversation" && continuationTurns.length > 0;
  const visibleTranscript = useMemo(() => {
    const items = detail?.transcript ?? [];
    return liveStreamVisible ? transcriptBeforeLiveStream(items, liveStreamBoundary) : items;
  }, [detail, liveStreamBoundary, liveStreamVisible]);
  // 파일 쪽에 남는 항목도, 더 불러올 이전 구간도 없으면 빈 '대화 내역' 머리말만 남는다.
  const transcriptSectionHidden = liveStreamVisible
    && Boolean(detail)
    && !detail?.unavailableReason
    && visibleTranscript.length === 0
    && earlierLoadCount === 0;

  const toggleSettings = () => setSettingsExpanded((current) => !current);
  useEffect(() => {
    if (!settingsExpanded || providerAccounts) return undefined;
    let cancelled = false;
    void getProviderAccounts()
      .then((snapshot) => {
        if (!cancelled) {
          setProviderAccounts(snapshot.accounts.filter((account) => account.provider === session.source));
        }
      })
      .catch(() => { if (!cancelled) setProviderAccounts([]); });
    return () => { cancelled = true; };
  }, [settingsExpanded, providerAccounts, session.source]);
  const accountLabel = (accountId: string) => {
    const account = providerAccounts?.find((candidate) => candidate.id === accountId);
    return account ? `${account.displayName} (${account.email})` : accountId;
  };
  /**
   * 고정된 계정의 한도가 모두 찼다면 초기화 시각(모르면 0). 고정 세션은 한도
   * 자동전환 대상이 아니라 고정을 바꾸기 전까지 실행이 계속 거부되므로, 실패를
   * 겪기 전에 고정하는 자리에서 알린다.
   */
  const pinnedAccountExhaustedResetAt = useMemo(() => {
    if (!meta.pinnedAccountId || !providerAccounts) return null;
    const pinned = providerAccounts.find((candidate) => candidate.id === meta.pinnedAccountId);
    if (!pinned) return null;
    // 모델별 창은 그 모델을 쓰는 실행만 막으므로 고정 경고의 근거가 되지 않는다.
    const exhausted = governingUsageWindows(displayUsageWindows(pinned.usage.windows, Date.now()))
      .filter((window) => window.usedPercent >= 100);
    if (exhausted.length === 0) return null;
    const resets = exhausted
      .map((window) => window.resetsAt)
      .filter((value): value is number => value !== null);
    return resets.length > 0 ? Math.min(...resets) : 0;
  }, [meta.pinnedAccountId, providerAccounts]);
  const selectableProviders = useMemo(
    () => providers.filter((provider) => provider.cli.detected || provider.provider === session.source),
    [providers, session.source],
  );
  const handoffLinks = useMemo(() => {
    const links = [
      ...(meta.handoffOrigin ? [{ kind: "origin" as const, link: meta.handoffOrigin }] : []),
      ...(meta.handoffTargets ?? []).map((link) => ({ kind: "target" as const, link })),
    ];
    return links.map((item) => ({
      ...item,
      session: sessions.find((candidate) => candidate.source === item.link.source && candidate.id === item.link.id) ?? null,
    }));
  }, [meta.handoffOrigin, meta.handoffTargets, sessions]);
  useEscapeToClose(() => setSettingsExpanded(false), settingsExpanded);
  useEffect(() => {
    if (!settingsExpanded) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (settingsPanelRef.current?.contains(target) || settingsToggleRef.current?.contains(target)) return;
      setSettingsExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [settingsExpanded]);

  return (
    <>
    <Drawer
      variant={popout ? "panel" : "overlay"}
      title={<>
        <SourceBadge source={session.source} />
        <button
          className={`session-favorite-toggle${meta.favorite ? " active" : ""}`}
          type="button"
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
        {!popout && <button
          className="button compact"
          type="button"
          onClick={() => { void openPopoutWindow({ kind: "session", source: session.source, sessionId: session.id }).catch((cause: unknown) => setError(errorText(cause))); }}
          title="이 세션을 별도 창으로 엽니다"
        ><AppWindow size={13} /><span>새 창으로 열기</span></button>}
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
              <button className={meta.favorite ? "button primary" : "button"} type="button" onClick={() => patchMeta({ favorite: !meta.favorite })}>
                <Star size={13} fill={meta.favorite ? "currentColor" : "none"} aria-hidden="true" /> 즐겨찾기
              </button>
              <button className="button danger-subtle" type="button" onClick={() => patchMeta({ hidden: !meta.hidden })}>
                {meta.hidden ? "보관 해제" : "보관"}
              </button>
            </div>
            <TranscriptLimitSelect
              label="세션 대화 표시 범위"
              value={transcriptLimit}
              itemCount={detail ? detail.transcript.length : null}
              onChange={onTranscriptLimitChange}
            />
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
                  title={folderPathLabel(folders, folder.id)}
                  onClick={() => patchMeta({ folderIds: assigned ? meta.folderIds.filter((id) => id !== folder.id) : [...meta.folderIds, folder.id] })}
                >
                  <i />
                  {folder.parentId && <span className="folder-pill-path">{folderPathLabel(folders, folder.parentId)} /</span>}
                  {folder.name}{assigned && <Check size={11} />}
                </button>;
              })}
            </div>
          </section>

          <section className="detail-card session-agent-handoff">
            <h4>이어갈 에이전트</h4>
            <div className="form-row">
              <label htmlFor="session-continuation-agent">에이전트</label>
              <select
                id="session-continuation-agent"
                value={continuationSource}
                disabled={continuationPhase === "connecting" || continuationPhase === "running" || continuationPhase === "waitingApproval"}
                onChange={(event) => void changeContinuationSource(event.target.value as ProviderId)}
              >
                {selectableProviders.map((provider) => <option
                  key={provider.provider}
                  value={provider.provider}
                  disabled={!provider.cli.detected}
                >
                  {provider.displayName}{provider.provider === session.source ? " · 원본" : ""}{!provider.cli.detected ? " · CLI 미연결" : ""}
                </option>)}
              </select>
            </div>
            <div className="form-row">
              <label>인계</label>
              <label className="check-filter">
                <input
                  type="checkbox"
                  checked={continuationSource !== session.source || continuationHandoff}
                  // 다른 공급자는 세션 ID를 공유할 수 없어 인계 말고는 길이 없고, 실행이
                  // 붙어 있는 동안에는 다음 전송이 그 실행으로 가므로 고를 것이 없다.
                  disabled={continuationSource !== session.source || !continuationDetached}
                  onChange={(event) => setContinuationHandoff(event.target.checked)}
                />
                새 세션으로 인계
              </label>
            </div>
            <small>{agentHandoffPending
              ? `${sourceName(continuationSource)}의 새 세션을 만들고 최근 사용자·에이전트 대화를 인계합니다. 원본 세션은 변경하지 않습니다.`
              : continuationDetached
                ? "원래 에이전트의 같은 세션을 이어갑니다."
                : "붙어 있는 실행에 이어서 전달합니다."}</small>
          </section>

          {handoffLinks.length > 0 && <section className="detail-card session-handoff-links">
            <h4>에이전트 인계 기록</h4>
            <div>
              {handoffLinks.map((item) => <button
                className="button"
                type="button"
                key={`${item.kind}:${item.link.source}:${item.link.id}`}
                disabled={!item.session}
                title={item.session ? "연결된 세션 열기" : "아직 세션 목록에서 찾지 못했습니다"}
                onClick={() => { if (item.session) onOpenRelatedSession(item.session); }}
              >
                <SourceBadge source={item.link.source} />
                <span>{item.kind === "origin" ? "원본" : "인계 대상"} · {item.session?.meta.customTitle ?? item.session?.sourceTitle ?? item.session?.title ?? item.link.id}</span>
              </button>)}
            </div>
          </section>}

          {providerAccounts !== null && providerAccounts.length > 0 && <section className="detail-card session-account-pin">
            <h4>{continuationSource !== session.source || continuationHandoff ? "원본 세션 실행 계정" : "실행 계정"}</h4>
            <div className="form-row">
              <label htmlFor="session-account-pin">고정</label>
              <select
                id="session-account-pin"
                value={meta.pinnedAccountId ?? ""}
                disabled={saving}
                onChange={(event) => patchMeta({ pinnedAccountId: event.target.value || null })}
              >
                <option value="">고정 없음 — 이어가기 설정에 따름</option>
                {providerAccounts.map((account) => <option key={account.id} value={account.id}>
                  {account.displayName} ({account.email}){account.isActive ? " · 기본" : ""}
                </option>)}
              </select>
            </div>
            <small>
              고정하면 이어가기 설정과 무관하게 이 계정으로 실행하고, 한도 자동전환도 이 세션을 다른 계정으로 옮기지 않습니다.
              {meta.boundAccountId && ` 마지막 실행 계정: ${accountLabel(meta.boundAccountId)}.`}
            </small>
            {pinnedAccountExhaustedResetAt !== null && <small className="session-account-pin-warning" role="alert">
              고정된 계정의 사용량 한도가 모두 찼습니다{pinnedAccountExhaustedResetAt > 0 ? ` (초기화 ${formatDate(pinnedAccountExhaustedResetAt)})` : ""}. 고정을 해제하거나 다른 계정으로 바꾸기 전까지 이 세션의 실행은 계속 거부됩니다.
            </small>}
          </section>}

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
              <Info label="경로" value={session.cwd ?? attachedCwd ?? "–"} mono />
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
      footer={activeTab === "conversation" ? <><ChatApprovalDock title="권한 승인 대기" hint="선택할 때까지 에이전트 작업이 일시 정지됩니다." prompts={pendingApprovals} onDecision={decideContinuation} /><SessionContinuationComposer
        value={continuationText}
        attachments={continuationAttachments}
        uploading={continuationUploading}
        source={continuationSource}
        agentHandoff={agentHandoffPending}
        mode={continuationMode}
        approvalMode={continuationApprovalMode}
        model={continuationModel}
        modelOptions={continuationModelOptions}
        recentModels={continuationRecentModels}
        reasoningEffort={continuationReasoningEffort}
        reasoningOptions={continuationReasoningOptions}
        settingFields={continuationSettingFields}
        extraSettings={continuationExtraSettings}
        phase={continuationPhase}
        planApprovalPending={pendingPlanApproval !== null}
        contextUsedTokens={displayedContextUsedTokens}
        contextWindowTokens={continuationContext.window}
        largeContextWarning={largeContextWarning}
        queue={continuationQueue}
        blockedReason={!continuationCwd
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
          void refreshProviderOptions(continuationSource).catch((cause) => {
            setContinuationError(`최신 실행 설정을 불러오지 못했습니다: ${errorText(cause)}`);
          });
        }}
        onSubmit={sendContinuation}
        onQueue={() => void deliverContinuation(false)}
        onDeliver={() => void deliverContinuation(true)}
        onInterrupt={interruptContinuation}
        onRemoveQueued={(messageId) => void removeContinuationQueued(messageId)}
        onRecallQueued={(item) => void recallContinuationQueued(item)}
      /></> : undefined}
    >
      {activeTab === "terminal" ? (
        <TerminalPanel session={session} />
      ) : <>
      {(error ?? transcriptError) && <ErrorBanner message={error ?? transcriptError ?? ""} />}
      {!transcriptSectionHidden && <section className={`transcript-section transcript-section-${activeTab}`}>
        <div className="section-title">
          <h3>{activeTab === "activity" ? "작업 로그" : "대화 내역"}</h3>
          <div className="section-title-actions">
            <span>
              {detail ? `${visibleTranscript.length.toLocaleString()}개 항목` : ""}
              {detail?.truncated ? " · 이전 항목 생략" : ""}
              {detail && detail.skippedLines > 0 ? ` · 읽지 못한 줄 ${detail.skippedLines.toLocaleString()}개` : ""}
            </span>
            {activeTab === "activity" ? <ActivityFilterSelect value={activityFilter} onChange={setActivityFilter} /> : null}
          </div>
        </div>
        {!detail && !transcriptError ? (
          <LoadingState label="대화 원문을 읽고 있습니다" />
        ) : detail?.unavailableReason ? (
          <EmptyState title="본문을 열 수 없습니다" detail={detail.unavailableReason} />
        ) : detail && visibleTranscript.length === 0 && earlierLoadCount === 0 ? (
          <EmptyState title="표시할 대화가 없습니다" />
        ) : (
          <>
            <TranscriptLoadEarlier
              count={earlierLoadCount}
              loading={loadingEarlier}
              error={earlierError}
              onLoad={() => void loadEarlierTranscript()}
            />
            <TranscriptTurns items={visibleTranscript} mode={activeTab === "activity" ? "activity" : "conversation"} activityFilter={activityFilter} source={detail?.session.source ?? null} sessionId={detail?.session.id ?? null} onOpenLocalLink={linkedFilePreview.open} scrollContainerRef={drawerBodyRef} windowed={transcriptLimit === "all"} />
          </>
        )}
      </section>}
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
    {confirmDialog}
    </>
  );
}

function SessionContinuationComposer({
  value,
  attachments,
  uploading,
  source,
  agentHandoff,
  mode,
  approvalMode,
  model,
  modelOptions,
  recentModels,
  reasoningEffort,
  reasoningOptions,
  settingFields,
  extraSettings,
  phase,
  planApprovalPending,
  contextUsedTokens,
  contextWindowTokens,
  largeContextWarning,
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
  onDeliver,
  onInterrupt,
  onRemoveQueued,
  onRecallQueued,
}: {
  value: string;
  attachments: ChatAttachmentDraft[];
  uploading: boolean;
  source: ProviderId;
  agentHandoff: boolean;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  modelOptions: ChatModelCatalogOption[];
  recentModels: ModelOption[];
  reasoningEffort: ReasoningEffort | "";
  reasoningOptions: ChatReasoningOption[];
  settingFields: ChatSettingField[];
  extraSettings: Record<string, string>;
  phase: ChatPhase | "idle" | "connecting";
  /** 지금 계획 승인을 기다리는 중인가. 그때만 요청 모드를 바꿔 계획을 넘길 수 있다. */
  planApprovalPending: boolean;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  largeContextWarning: string | null;
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
  onDeliver: () => void;
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
          : agentHandoff
            ? `${sourceName(source)}의 새 세션으로 인계할 요청을 입력하세요`
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
        recentModels={recentModels}
        reasoningEffort={reasoningEffort}
        reasoningOptions={reasoningOptions}
        settingFields={settingFields}
        extraSettings={extraSettings}
        locked={modeLocked}
        planRestartLocked={phase === "connecting" || (busy && !planApprovalPending)}
        planRestartNote={planApprovalPending
          ? "계획 승인 중입니다. 지금 요청 모드를 바꾸면 이 실행은 계획을 승인하지 않고 접히고, 계획이 새 실행으로 넘어갑니다."
          : undefined}
        statusIndicator={<span className={`terminal-status terminal-status-${phase}`} />}
        contextMeter={<ChatContextMeter usedTokens={contextUsedTokens} windowTokens={contextWindowTokens} />}
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
      {largeContextWarning && <div className="session-context-warning" role="status">{largeContextWarning}</div>}
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
        canDeliver={supportsDeliveryDuringTurn(source)}
        onChange={onChange}
        onAddFiles={onAddFiles}
        onRemoveAttachment={onRemoveAttachment}
        onSubmit={onSubmit}
        onQueue={onQueue}
        onDeliver={onDeliver}
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
