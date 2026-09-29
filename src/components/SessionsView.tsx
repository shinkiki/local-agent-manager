import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Archive, ArchiveRestore, Check, ChevronDown, ExternalLink, Folder, GripVertical, MessagesSquare, PanelLeftOpen, ScrollText, SlidersHorizontal, SquareTerminal, Star, TriangleAlert, type LucideIcon } from "lucide-react";
import { attachChat, connectChat, supportsDeliveryDuringTurn, type ChatConnection } from "../lib/chat";
import { BACKEND_RESTARTED_MESSAGE, ChatRejectedError } from "../lib/chatReconnect";
import {
  downloadSessionLinkedFile,
  getDetachedChatForSession,
  getProviderAccounts,
  getSessionLinkedFile,
  hasTauriRuntime,
  openProviderSessionApp,
} from "../lib/ipc";
import { formatBytes, formatDate, formatRelative, formatTokens, sourceName } from "../lib/format";
import { PROVIDER_IDS } from "../lib/providerIds";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";
import { useI18n, type UiText } from "../lib/i18n";
import { runtimeText } from "../lib/i18nRuntime";
import { openPopoutWindow, usePopoutWindowTitle } from "../lib/popoutWindow";
import { catalogHealthNotice } from "../lib/catalogHealth";
import { accountExhaustionResetAt, displayUsageWindows } from "../lib/accountUsage";
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
  folderPathLabel,
  hiddenByFolders,
  hiddenFolderIds,
  visibleFolderSubtreeIds,
} from "../lib/sessionFolders";
import { defaultApprovalMode, normalizeExtraSettings, normalizeSettingValue, permissionModeLabel, reasoningLabel, sameChatSettings, settingFieldsFor, type ChatSettingField } from "../lib/chatSettings";
import { liveStreamBoundaryMs, transcriptBeforeLiveStream } from "../lib/transcriptOverlap";
import { planExecutionRequest } from "../lib/planRestart";
import { buildSessionHandoffMessage } from "../lib/sessionHandoff";
import { saveSessionMetaPatch } from "../lib/sessionMetaSave";
import { orderSessionsForList } from "../lib/sessionList";
import { sessionKey } from "../lib/sessionKey";
import { sessionFailureTitle } from "../lib/sessionFailure";
import {
  ActivityFilterSelect,
  TranscriptLimitSelect,
  TranscriptLoadEarlier,
  TranscriptTurns,
  useSessionTranscript,
  type SessionTranscriptState,
} from "./SessionTranscript";
import type { ActivityFilter } from "../lib/activityFilter";
import { useReadingBookmarks } from "./ReadingBookmarks";
import { FIND_PRIORITY, useChatFind } from "./ChatFindBar";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { ChatApprovalDock, ChatContextMeter, Drawer, EmptyState, ErrorBanner, LoadingState, ProviderMark, SourceBadge, useConfirm, useEscapeToClose, useFileDropZone, useOutsidePointerToClose } from "./Shared";
import { TerminalPanel } from "./TerminalPanel";
import { ChatRuntimeSettingsMenu } from "./ChatRuntimeSettingsMenu";
import {
  addAttachmentDrafts,
  queuedAttachmentsToDrafts,
  releaseAttachmentDraftUpload,
  sendWithAttachmentDrafts,
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
import { SessionFolderSidebar, type FolderFilter } from "./SessionFolderSidebar";
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

type SessionContextMenuState = { source: ProviderId; id: string; x: number; y: number };
type SessionHandoffLink = NonNullable<SessionMeta["handoffOrigin"]>;

interface ResolvedSessionHandoffLink {
  kind: "origin" | "target";
  link: SessionHandoffLink;
  session: SessionSummary | null;
}

type SessionIdentity = Pick<SessionSummary, "source" | "id">;

/** 세션을 가리키는 여러 UI 상태가 공급자와 ID를 같은 규칙으로 비교하게 한다. */
function sameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return left.source === right.source && left.id === right.id;
}

/** 인계 출처·대상 링크를 표시 순서대로 모으고 현재 카탈로그의 세션과 연결한다. */
function resolveSessionHandoffLinks(
  meta: SessionMeta,
  sessions: SessionSummary[],
): ResolvedSessionHandoffLink[] {
  const links: Pick<ResolvedSessionHandoffLink, "kind" | "link">[] = [
    ...(meta.handoffOrigin ? [{ kind: "origin" as const, link: meta.handoffOrigin }] : []),
    ...(meta.handoffTargets ?? []).map((link) => ({ kind: "target" as const, link })),
  ];
  return links.map((item) => ({
    ...item,
    session: sessions.find((candidate) => sameSessionIdentity(candidate, item.link)) ?? null,
  }));
}

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
  includeSchedule: boolean;
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
  // 반복 요청이 돌린 회차 세션은 사람이 시작한 대화보다 훨씬 빨리 쌓인다. 기본으로 접어
  // 두고, 회차를 훑어야 할 때만 켠다.
  includeSchedule: false,
};

/**
 * 목록을 좁히는 칩 세 개는 "눌림 = 필터 한 항목"이라는 같은 버튼이라, 마크업을 한 벌만 두고
 * 갈래마다 다른 것(키·아이콘·문구·설명·위험 표시)만 표로 적는다. 칩을 늘릴 때 어느 한 자리
 * (aria-pressed·className·onClick)를 빠뜨려 눌림 표시와 실제 필터가 어긋나는 일을 막는다.
 */
function sessionFilterChips(text: UiText): {
  key: "favoritesOnly" | "showHidden" | "failuresOnly";
  label: string;
  title: string;
  danger?: boolean;
  icon: (active: boolean) => ReactNode;
}[] {
  return [
    {
      key: "favoritesOnly",
      label: text("즐겨찾기", "Favorites"),
      title: text("별표를 단 세션만 봅니다", "Show only starred sessions"),
      icon: (active) => <Star size={12} fill={active ? "currentColor" : "none"} aria-hidden="true" />,
    },
    {
      key: "showHidden",
      label: text("보관함", "Archived"),
      title: text("보관함으로 옮긴 세션만 봅니다", "Show only archived sessions"),
      icon: () => <Archive size={12} aria-hidden="true" />,
    },
    {
      key: "failuresOnly",
      label: text("실패", "Failed"),
      title: text("마지막 요청이 한도 초과·오류로 끝난 세션만 봅니다", "Show only sessions ended with limit exceeded or error"),
      danger: true,
      icon: () => <TriangleAlert size={12} aria-hidden="true" />,
    },
  ];
}

/**
 * 추가 필터 팝오버의 체크박스 세 개도 "체크 = 포함"이라는 같은 모양이다. 기본값과 다른
 * 항목 수를 세는 칩 배지도 이 표를 그대로 쓰므로, 항목을 늘려도 배지가 따로 뒤처지지 않는다.
 */
const SESSION_MORE_FILTER_KEYS = [
  "includeArchived",
  "includeSubagents",
  "includeAia",
  "includeSchedule",
] as const;

function sessionMoreFilterChecks(text: UiText): { key: (typeof SESSION_MORE_FILTER_KEYS)[number]; label: string }[] {
  return [
    { key: "includeArchived", label: text("공급자 보관 세션 포함", "Include provider-archived sessions") },
    { key: "includeSubagents", label: text("서브에이전트 포함", "Include subagents") },
    { key: "includeAia", label: text("AIA 대화 포함", "Include AIA chats") },
    { key: "includeSchedule", label: text("반복 요청 포함", "Include scheduled runs") },
  ];
}

/**
 * 반복 요청이 돌린 세션인지. 출처 종류만 보면 안 된다 — 반복 요청이 프롬프트를 직접
 * 돌리면 `schedule`이지만, 등록된 시스템 워크플로(페이싱 회차 포함)를 돌리면 단계마다
 * 열리는 채팅의 종류가 `workflow`이고 반복 요청 id는 `scheduleId`에만 실린다. 정작
 * 목록을 덮는 쪽은 회차마다 여러 건이 열리는 후자라, `scheduleId`가 있으면 반복 요청이
 * 시작한 세션으로 본다. 사람이 직접 돌린 워크플로는 `scheduleId`가 비어 그대로 보인다.
 */
function startedBySchedule(session: SessionSummary): boolean {
  const origin = session.meta.origin;
  if (!origin) return false;
  return origin.kind === "schedule" || Boolean(origin.scheduleId);
}

/**
 * 목록을 좁히는 축 한 벌. 축이 하나 늘 때마다 걸러내기가 여러 자리에 흩어지지 않도록
 * 판정을 여기 한 벌만 둔다.
 *
 * 축에 걸린 세션을 바깥(알림·대시보드·실행 이력)에서 열었을 때는 필터 값을 되돌리지
 * 않는다. 예전에는 축마다 '드러내는 값'을 함께 들고 다니며 필터를 실제로 켰는데, 알림에서
 * 반복 요청 회차를 한 번 열면 '반복 요청 포함'이 켜진 채 남아 이후 목록이 회차 세션으로
 * 덮였다. 지금은 연 세션 한 건만 목록에 끼워 넣는다(`pinnedKey`).
 */
type SessionListFilterAxis = (session: SessionSummary, filters: SessionListFilters) => boolean;

const SESSION_LIST_FILTER_AXES: SessionListFilterAxis[] = [
  (session, filters) => matchesSessionQuery(session, filters.query),
  (session, filters) => filters.source === "all" || session.source === filters.source,
  (session, filters) => filters.project === "all" || session.cwd === filters.project,
  // 보관함 칩은 켜면 보관한 세션'만' 보여 준다. 이 축만 양방향으로 걸러낸다.
  (session, filters) => filters.showHidden === session.meta.hidden,
  (session, filters) => filters.includeArchived || !session.archived,
  (session, filters) => filters.includeSubagents || !session.isSubagent,
  (session, filters) => filters.includeAia || !session.aiaWorkspace,
  // 출처는 채팅을 만들 때 서버가 한 번만 적는다. 반복 요청이 돌린 회차 세션은 여기서만
  // 가려낼 수 있다 — 숨긴 '반복 요청' 폴더는 그 폴더를 직접 고르면 다시 열리기 때문이다.
  (session, filters) => filters.includeSchedule || !startedBySchedule(session),
  (session, filters) => !filters.favoritesOnly || Boolean(session.meta.favorite),
  (session, filters) => !filters.failuresOnly || Boolean(session.lastFailure),
];

// 폴더 조건만 뺀 걸러내기. 폴더 사이드바 개수를 이 조건으로 세어야 "미분류 98건"을 눌렀는데
// 숨김·보관·서브에이전트로 걸러져 목록이 0건이 되는 어긋남이 생기지 않는다.
function sessionMatchesListFilters(session: SessionSummary, filters: SessionListFilters): boolean {
  return SESSION_LIST_FILTER_AXES.every((matches) => matches(session, filters));
}

/**
 * 바깥(알림·대시보드·실행 이력)에서 연 세션 한 건이 `list`에 빠져 있으면 `pool`에서 찾아
 * 뒤에 붙인다. 걸러 낸 전체 목록과 실제로 그리는 구간이 "키로 찾고, 빠졌을 때만 붙인다"는
 * 같은 규칙을 각각 풀어 적고 있었다. 한쪽만 고치면 끼워 넣은 세션이 목록에는 들어 있는데
 * 화면에는 없는(또는 그 반대의) 어긋남이 나므로 규칙은 여기 한 벌만 둔다.
 */
function withPinnedSession(
  list: SessionSummary[],
  pinnedKey: string | null,
  pool: SessionSummary[],
): SessionSummary[] {
  if (!pinnedKey || list.some((session) => sessionKey(session.source, session.id) === pinnedKey)) return list;
  const pinned = pool.find((session) => sessionKey(session.source, session.id) === pinnedKey);
  return pinned ? [...list, pinned] : list;
}

/**
 * 세션을 폴더에 담거나 빼는 한 번의 조작 결과. 세 자리(행을 폴더로 끌어다 놓기 · 우클릭
 * 메뉴의 폴더 지정 · 상세의 폴더 고르기)가 같은 규칙을 각각 삼항식으로 적고 있었고,
 * `미분류`를 고르면 비운다는 조건이 두 자리에만 있어 규칙이 한 벌인지 읽어 봐야 알 수
 * 있었다. 규칙은 여기 한 벌만 두고, 갈래마다 다른 것은 `mode` 하나로 남긴다.
 *
 * - `folderId`가 null이면 어느 폴더에도 담지 않은 상태(미분류)로 비운다.
 * - 이미 담긴 폴더를 다시 고르면 `toggle`은 빼고, `add`는 그대로 둔다. 끌어다 놓기는
 *   담는 조작이지 빼는 조작이 아니므로 원래 목록을 그대로 돌려준다.
 */
function nextSessionFolderIds(current: string[], folderId: string | null, mode: "add" | "toggle"): string[] {
  if (folderId === null) return [];
  if (!current.includes(folderId)) return [...current, folderId];
  return mode === "toggle" ? current.filter((id) => id !== folderId) : current;
}

/** 담긴 폴더가 그대로인지. 바뀌지 않은 조작으로 메타데이터 파일을 다시 쓰지 않으려는 판정이다. */
function sameSessionFolderIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 세션 목록 위 공급자 탭. '전체' 다음에 공급자를 정본 순서대로 늘어놓는다. */
const SESSION_SOURCE_TABS: readonly SessionListFilters["source"][] = ["all", ...PROVIDER_IDS];

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

/**
 * 세션 목록을 좁히는 일 한 벌. 필터 축·폴더 선택·그리는 구간·바깥에서 연 세션의 되돌리기가
 * 서로를 물고 있어(축이 바뀌면 구간이 처음으로 돌아가야 하고, 목록에 없는 세션을 열면 그
 * 세션이 걸리는 축만 풀어야 한다) 목록 화면 본문에 흩어져 있으면 한 자리만 고쳐도 나머지가
 * 어긋났다. 좁히기는 여기 한 벌만 두고, 화면 본문에는 그 결과를 배치하는 일만 남긴다.
 */
/**
 * 프로젝트 좁히기 칸에 세울 항목 하나. 값은 세션의 작업 경로고, 보이는 문구는 그 경로를
 * 사람이 읽을 꼴로 줄인 것이다. 화면 쪽에서 다시 줄이지 않도록 완성된 문구로 넘긴다.
 */
interface SessionProjectOption {
  /** 필터 값으로 쓰는 세션의 작업 경로(`SessionListFilters.project`). */
  path: string;
  label: string;
  count: number;
}

/**
 * 지금 들고 있는 세션에서 프로젝트 좁히기 목록을 만든다. 등록 프로젝트 목록(`ProjectOption`)과
 * 달리 보관·AIA 세션도 세는데, 이 칸은 "새 작업을 시작할 프로젝트"가 아니라 "이 목록에
 * 들어 있는 세션을 가르는 축"이라 목록에 보이는 것은 모두 고를 수 있어야 하기 때문이다.
 * 세션이 많은 프로젝트를 앞에 둔다.
 */
function collectSessionProjectOptions(sessions: SessionSummary[]): SessionProjectOption[] {
  const counts = new Map<string, SessionProjectOption>();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const known = counts.get(session.cwd);
    if (known) {
      known.count += 1;
      continue;
    }
    counts.set(session.cwd, { path: session.cwd, label: displayPath(session.project ?? session.cwd), count: 1 });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count);
}

interface SessionListScope {
  filters: SessionListFilters;
  patchFilters: (patch: Partial<SessionListFilters>) => void;
  folderFilter: FolderFilter;
  selectFolder: (folder: FolderFilter) => void;
  /** 프로젝트 좁히기 칸에 세울 항목. 필터가 걸리기 전 전체 세션에서 센다. */
  projects: SessionProjectOption[];
  /** 폴더 조건만 뺀 목록. 폴더 사이드바 개수를 목록과 같은 기준으로 세는 데 쓴다. */
  folderScoped: SessionSummary[];
  /** 폴더까지 좁히고 즐겨찾기를 앞으로 올린 전체 목록. */
  filtered: SessionSummary[];
  /** 그 가운데 실제로 그리는 구간. */
  visible: SessionSummary[];
  /** '더 보기'. 그리는 구간을 한 쪽만큼 늘린다. */
  showMore: () => void;
}

function useSessionListScope(
  sessions: SessionSummary[],
  folders: SessionFolder[],
  selected: SessionSummary | null,
  onSelect: (session: SessionSummary | null) => void,
): SessionListScope {
  // 마지막 요청이 한도 초과·오류로 끝난 세션만 추려 보는 failuresOnly는 되돌릴 대화를 찾는
  // 흐름이라 즐겨찾기·보관함과 같은 '좁히기' 칩으로 묶여 있다.
  const [filters, setFilters] = useState<SessionListFilters>(DEFAULT_SESSION_LIST_FILTERS);
  const patchFilters = useCallback((patch: Partial<SessionListFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  // 바깥에서 열어 준 세션 한 건. 지금 필터·폴더에 걸려 있어도 이 한 건만 목록에 끼워 넣는다.
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);

  const projects = useMemo(() => collectSessionProjectOptions(sessions), [sessions]);

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

  const folderPasses = useCallback((session: SessionSummary) => {
    if (folderFilter === "unfiled" && session.meta.folderIds.length > 0) return false;
    // 숨긴 폴더에만 담긴 세션은 전체 목록에서 뺀다. 보이는 폴더에도 담겨 있으면 그
    // 폴더에서 계속 봐야 하므로 남긴다.
    if (folderFilter === "all" && hiddenByFolders(session.meta.folderIds, hiddenFolders)) return false;
    // 상위 폴더를 고르면 하위 폴더에 담긴 세션까지 함께 본다.
    if (folderSubtree && !session.meta.folderIds.some((folderId) => folderSubtree.has(folderId))) return false;
    return true;
  }, [folderFilter, folderSubtree, hiddenFolders]);

  // 즐겨찾기를 앞으로 올린 뒤 잘라 낸다. 정렬을 렌더 구간 뒤에 두면 별표를 단 오래된
  // 세션이 '더 보기'를 몇 번 누른 뒤에야 나타난다. 바깥에서 열어 준 세션은 필터에 걸려도
  // 여기서만 한 건 끼워 넣는다 — 필터 값 자체는 사용자가 둔 그대로 남는다.
  const filtered = useMemo(
    () => orderSessionsForList(withPinnedSession(folderScoped.filter(folderPasses), pinnedKey, sessions)),
    [folderScoped, folderPasses, pinnedKey, sessions],
  );

  // 787건 규모에서 전체 행을 매 렌더마다 그리면 원격 웹(특히 모바일)이 눌린다.
  // 필터와 검색은 전체 목록으로 계산하고, 실제로 그리는 행 수만 늘려 간다.
  const [renderLimit, setRenderLimit] = useState(SESSION_RENDER_PAGE);
  useEffect(() => { setRenderLimit(SESSION_RENDER_PAGE); }, [filters, folderFilter]);
  // 끼워 넣은 세션은 정렬 결과가 첫 쪽 밖으로 밀려도 반드시 그린다. 바깥에서 연 세션이
  // '더 보기'를 눌러야 나타나면 끼워 넣은 뜻이 없다.
  const visible = useMemo(
    () => withPinnedSession(filtered.slice(0, renderLimit), pinnedKey, filtered),
    [filtered, pinnedKey, renderLimit],
  );
  const showMore = useCallback(() => setRenderLimit((current) => current + SESSION_RENDER_PAGE), []);

  // 선택된 세션이 목록에 없을 때의 처리. 목록에 한 번 올라온 뒤(settled) 사라졌다면
  // 사용자가 필터를 바꾼 것이므로 상세를 닫고, 바깥에서 막 연 세션이라면 목록에 끼워 넣는다.
  //
  // 반복 요청 실행 이력·알림·대시보드에서 연 세션은 지금 필터에 걸려 목록에 없을 수 있다.
  // 특히 반복 회차 세션은 기본으로 접어 두는 '반복 요청 포함'과 숨긴 '반복 요청' 폴더 양쪽에
  // 걸리므로, 선택만 풀어 버리면 "열기를 눌렀는데 아무 것도 안 열린다"가 된다. 그렇다고
  // 필터를 켜 버리면 알림 하나를 열어 본 대가로 이후 목록이 회차 세션으로 덮이므로, 연
  // 세션 한 건만 끼워 넣고(pin) 상세를 닫을 때 걷는다.
  const selectionRef = useRef<{ key: string; settled: boolean } | null>(null);
  useEffect(() => {
    if (!selected) {
      selectionRef.current = null;
      setPinnedKey(null);
      return;
    }
    const key = sessionKey(selected.source, selected.id);
    // 끼워 넣기 없이도 목록에 나오는지로 판정한다. 끼워 넣은 세션까지 '보인다'로 세면
    // 필터를 바꿔 가려진 순간을 영영 알 수 없다.
    const shownOnItsOwn = sessionMatchesListFilters(selected, filters) && folderPasses(selected);
    if (shownOnItsOwn) {
      selectionRef.current = { key, settled: true };
      setPinnedKey((current) => (current === key ? null : current));
      return;
    }
    const tracked = selectionRef.current?.key === key ? selectionRef.current : null;
    if (tracked?.settled) {
      onSelect(null);
      return;
    }
    if (tracked) return;
    selectionRef.current = { key, settled: false };
    setPinnedKey(key);
  }, [filters, folderPasses, onSelect, selected]);

  return { filters, patchFilters, folderFilter, selectFolder: setFolderFilter, projects, folderScoped, filtered, visible, showMore };
}

/**
 * 폴더 패널을 접고 펴는 데 딸린 것 전부 — 저장된 열림 상태, 토글할 때 초점을 받을
 * 버튼, 접혔을 때 복원 버튼이 쓸 라벨. 목록 화면 본문에서는 이 여섯 선언이 필터·
 * 드래그·메타 수정 사이에 흩어져 있어 어디까지가 한 관심사인지 보이지 않았다.
 *
 * 접근성 이름은 현재 폴더를 끼워 넣은 문장이라 정적 치환기가 통째로 대응할 수
 * 없으므로(QA #19), 언어별 문장을 여기서 완성해 넘긴다.
 */
function useSessionFolderPane(folders: SessionFolder[], folderFilter: FolderFilter): {
  open: boolean;
  setOpen: (open: boolean) => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  restoreButtonRef: RefObject<HTMLButtonElement | null>;
  collapsedLabel: string;
  collapsedRestoreLabel: string;
} {
  const { text } = useI18n();
  const [open, setOpenState] = useState(() => readSecondaryPaneOpen(SESSION_FOLDER_PANE_OPEN_KEY));
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const focusTargetRef = useRef<"close" | "restore" | null>(null);

  const setOpen = (next: boolean) => {
    focusTargetRef.current = next ? "close" : "restore";
    setOpenState(next);
  };

  useEffect(() => writeSecondaryPaneOpen(SESSION_FOLDER_PANE_OPEN_KEY, open), [open]);
  useLayoutEffect(() => {
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    if (target === "close") closeButtonRef.current?.focus();
    else restoreButtonRef.current?.focus();
  }, [open]);

  const selectedFolderName = folderFilter === "all" || folderFilter === "unfiled"
    ? null
    : folders.find((folder) => folder.id === folderFilter)?.name ?? null;
  const collapsedLabel = folderFilter === "unfiled"
    ? text("미분류", "Unfiled")
    : selectedFolderName ?? text("폴더", "Folders");
  const collapsedRestoreLabel = folderFilter === "unfiled"
    ? text("세션 폴더 보기 · 현재 미분류", "Show session folders · current: Unfiled")
    : selectedFolderName
      ? text(`세션 폴더 보기 · 현재 ${selectedFolderName}`, `Show session folders · current: ${selectedFolderName}`)
      : text("세션 폴더 보기 · 현재 폴더", "Show session folders · current: Folders");

  return { open, setOpen, closeButtonRef, restoreButtonRef, collapsedLabel, collapsedRestoreLabel };
}

/**
 * 목록 화면이 직접 일으키는 동작 한 벌 — 메타 낙관 갱신, 폴더 배정, 우클릭 메뉴, 팝아웃
 * 열기. 넷은 실패하면 모두 목록 위 배너 한 줄로만 말하는데, 화면 본문에 흩어져 있어
 * 오류를 비우고 남기는 자리와 메뉴를 닫는 자리가 제각기 늘어나 있었다. 한 자리에 모아
 * 본문은 결과와 핸들러만 쓴다. 우클릭 대상은 여기서 지금 목록의 세션으로 풀어 돌려주므로
 * (사라진 세션을 가리키던 메뉴는 스스로 닫는다) 본문은 좌표와 세션을 함께 받는다.
 */
function useSessionListActions(
  sessions: SessionSummary[],
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void,
) {
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null);

  // 메타 수정은 서버 왕복 위에 메타데이터 파일을 통째로 다시 쓰는 작업이 얹힌다. 그것을
  // 기다린 뒤에 화면을 바꾸면 별표나 보관 토글이 누른 뒤에도 한참 예전 상태로 남는다.
  // 화면을 먼저 바꾸고, 서버가 거절하면 이전 값으로 되돌린다.
  const patchMeta = useCallback(async (session: SessionSummary, patch: Partial<SessionMeta>) => {
    await saveSessionMetaPatch(
      session.source,
      session.id,
      session.meta,
      patch,
      (meta) => onMetaChanged(session.source, session.id, meta),
      setError,
    );
  }, [onMetaChanged]);

  const assignToFolder = useCallback(async (session: SessionSummary, folderId: string | null) => {
    const folderIds = nextSessionFolderIds(session.meta.folderIds, folderId, "add");
    if (sameSessionFolderIds(folderIds, session.meta.folderIds)) return;
    await patchMeta(session, { folderIds });
  }, [patchMeta]);

  const contextSession = contextMenu
    ? sessions.find((session) => sameSessionIdentity(session, contextMenu)) ?? null
    : null;
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  useEffect(() => {
    if (contextMenu && !contextSession) setContextMenu(null);
  }, [contextMenu, contextSession]);

  const openContextMenu = useCallback((session: SessionSummary, x: number, y: number) => {
    setContextMenu({ source: session.source, id: session.id, x, y });
  }, []);

  const runContextMetaAction = useCallback(async (session: SessionSummary, patch: Partial<SessionMeta>) => {
    setContextMenu(null);
    await patchMeta(session, patch);
  }, [patchMeta]);

  const openPopout = useCallback((session: SessionSummary) => {
    setContextMenu(null);
    void openPopoutWindow({ kind: "session", source: session.source, sessionId: session.id })
      .catch((cause: unknown) => setError(errorText(cause)));
  }, []);

  return {
    error,
    contextTarget: contextMenu && contextSession ? { session: contextSession, x: contextMenu.x, y: contextMenu.y } : null,
    assignToFolder,
    closeContextMenu,
    openContextMenu,
    runContextMetaAction,
    openPopout,
  };
}

export function SessionsView({ providers, sessions, folders, selected, messageDisplayMode, transcriptLimit, onTranscriptLimitChange, onSelect, onMetaChanged, onFoldersChanged, onSessionCatalogChanged, attentionTarget, onAttentionTargetHandled, catalogHealth = null, onRefreshList, popout = false }: SessionsProps) {
  const { text } = useI18n();
  const { filters, patchFilters, folderFilter, selectFolder, projects, folderScoped, filtered, visible, showMore } =
    useSessionListScope(sessions, folders, selected, onSelect);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const folderPane = useSessionFolderPane(folders, folderFilter);
  const handleAttentionAttach = useCallback((opened: boolean) => {
    if (attentionTarget) onAttentionTargetHandled(attentionTarget, opened);
  }, [attentionTarget, onAttentionTargetHandled]);
  const listActions = useSessionListActions(sessions, onMetaChanged);

  const { draggedSession, previewPoint, dropTarget, armDrag, swallowsClick } = useSessionFolderDrag(listActions.assignToFolder);

  const contextTarget = listActions.contextTarget;

  // 팝아웃 창 제목으로 어떤 세션을 띄운 창인지 구분한다.
  usePopoutWindowTitle(popout && selected ? selected.title : null);

  const sessionDetail = selected ? (
    <SessionDrawer
      key={sessionKey(selected.source, selected.id)}
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
    return <div className="session-popout">{sessionDetail ?? <LoadingState label={text("세션을 여는 중…", "Opening session…")} />}</div>;
  }

  return (
    <div className={`sessions-layout${folderPane.open ? "" : " folders-closed"}`}>
      {folderPane.open && <SessionFolderSidebar
        sessions={sessions}
        scopedSessions={folderScoped}
        folders={folders}
        active={folderFilter}
        draggedSession={draggedSession}
        dropTarget={dropTarget}
        onSelect={selectFolder}
        onFoldersChanged={onFoldersChanged}
        onClose={() => folderPane.setOpen(false)}
        closeButtonRef={folderPane.closeButtonRef}
      />}
      {draggedSession && previewPoint && <div className="session-drag-preview" style={{ left: previewPoint.x + 14, top: previewPoint.y + 14 }} aria-hidden="true"><span className="drag-preview-grip"><GripVertical size={14} /></span><SessionSourceMark source={draggedSession.source} /><strong>{draggedSession.title}</strong></div>}
      <div className="session-list-pane">
      {listActions.error && <ErrorBanner message={listActions.error} />}
      <CatalogHealthBanner health={catalogHealth} onRefresh={onRefreshList} />
      <SessionListToolbar
        filters={filters}
        projects={projects}
        moreFiltersOpen={moreFiltersOpen}
        folderPaneOpen={folderPane.open}
        folderPaneRestoreRef={folderPane.restoreButtonRef}
        collapsedFolderLabel={folderPane.collapsedLabel}
        collapsedFolderRestoreLabel={folderPane.collapsedRestoreLabel}
        onPatchFilters={patchFilters}
        onMoreFiltersOpenChange={setMoreFiltersOpen}
        onOpenFolderPane={() => folderPane.setOpen(true)}
      />

      <SessionTable
        sessions={visible}
        total={filtered.length}
        folders={folders}
        draggedSession={draggedSession}
        onOpen={(session) => { if (!swallowsClick()) onSelect(session); }}
        onContextMenu={(session, x, y) => {
          setMoreFiltersOpen(false);
          listActions.openContextMenu(session, x, y);
        }}
        onArmDrag={armDrag}
        onLoadMore={showMore}
      />
      </div>

      {contextTarget && <SessionContextMenu
        session={contextTarget.session}
        folders={folders}
        anchorX={contextTarget.x}
        anchorY={contextTarget.y}
        onClose={listActions.closeContextMenu}
        onOpen={() => {
          listActions.closeContextMenu();
          onSelect(contextTarget.session);
        }}
        onOpenPopout={() => listActions.openPopout(contextTarget.session)}
        onToggleFavorite={() => listActions.runContextMetaAction(contextTarget.session, { favorite: !contextTarget.session.meta.favorite })}
        onChooseFolder={(folderId) => listActions.runContextMetaAction(contextTarget.session, {
          folderIds: nextSessionFolderIds(contextTarget.session.meta.folderIds, folderId, "toggle"),
        })}
        onToggleArchived={() => listActions.runContextMetaAction(contextTarget.session, { hidden: !contextTarget.session.meta.hidden })}
      />}

      {sessionDetail}
    </div>
  );
}

/**
 * 세션 목록의 좁히기 줄. 공급자 탭 · 검색 · 프로젝트 · 칩 · 추가 필터 팝오버가 모두
 * 같은 필터 한 벌만 만지므로, 목록 화면 본문에서 이 줄만 떼어 둔다. 팝오버를 닫는
 * 바깥 클릭·Esc도 여기 딸린 관심사라 함께 옮겼다. 열림 상태만 바깥에 두는 것은 목록
 * 행의 우클릭이 팝오버를 먼저 닫아야 하기 때문이다.
 */
function SessionListToolbar({
  filters,
  projects,
  moreFiltersOpen,
  folderPaneOpen,
  folderPaneRestoreRef,
  collapsedFolderLabel,
  collapsedFolderRestoreLabel,
  onPatchFilters,
  onMoreFiltersOpenChange,
  onOpenFolderPane,
}: {
  filters: SessionListFilters;
  projects: SessionProjectOption[];
  moreFiltersOpen: boolean;
  folderPaneOpen: boolean;
  folderPaneRestoreRef: RefObject<HTMLButtonElement | null>;
  collapsedFolderLabel: string;
  collapsedFolderRestoreLabel: string;
  onPatchFilters: (patch: Partial<SessionListFilters>) => void;
  onMoreFiltersOpenChange: (open: boolean) => void;
  onOpenFolderPane: () => void;
}) {
  const { text } = useI18n();
  const moreFiltersRef = useRef<HTMLDivElement | null>(null);
  const filterChips = sessionFilterChips(text);
  const moreFilterChecks = sessionMoreFilterChecks(text);

  // 추가 필터는 툴바 위에 떠 있는 팝오버다. 바깥 클릭·Esc로 닫아 목록 조작을 막지 않는다.
  useEscapeToClose(() => onMoreFiltersOpenChange(false), moreFiltersOpen);
  useOutsidePointerToClose(() => onMoreFiltersOpenChange(false), moreFiltersOpen, [moreFiltersRef]);

  // 접혀 있을 때도 무엇이 걸려 있는지 알 수 있게, 기본값과 다른 항목 수를 칩에 적는다.
  const adjustedMoreFilters = moreFilterChecks
    .filter(({ key }) => filters[key] !== DEFAULT_SESSION_LIST_FILTERS[key]).length;

  return (
    <section className="toolbar-card">
      {!folderPaneOpen && <button ref={folderPaneRestoreRef} className="secondary-pane-restore" type="button" data-ui-anchor="sessions.folders" onClick={onOpenFolderPane} aria-label={collapsedFolderRestoreLabel} title={collapsedFolderRestoreLabel} aria-expanded={false}><PanelLeftOpen size={15} /><span>{collapsedFolderLabel}</span></button>}
      <div className="source-tabs">
        {SESSION_SOURCE_TABS.map((item) => (
          <button
            className={filters.source === item ? "active" : ""}
            key={item}
            type="button"
            onClick={() => onPatchFilters({ source: item })}
          >
            {item === "all" ? text("전체", "All") : sourceName(item)}
          </button>
        ))}
      </div>
      <input
        className="search-input"
        value={filters.query}
        onChange={(event) => onPatchFilters({ query: event.target.value })}
        placeholder={text("제목·프로젝트·ID·메모 검색", "Search title, project, ID, memo")}
      />
      <select value={filters.project} onChange={(event) => onPatchFilters({ project: event.target.value })}>
        <option value="all">{text("프로젝트 전체", "All projects")}</option>
        {projects.map((project) => (
          <option value={project.path} key={project.path}>{project.label} ({project.count})</option>
        ))}
      </select>
      {/* 목록을 좁히는 조건은 칩 한 묶음으로 모은다. 체크박스로 흩어 두면 좁은 화면에서
          줄바꿈이 제각각 끊겨 어떤 조건이 걸려 있는지 한눈에 읽히지 않는다. */}
      <div className="filter-chips" role="group" aria-label={text("세션 좁히기", "Filter sessions")}>
        {filterChips.map(({ key, label, title, danger, icon }) => {
          const active = filters[key];
          return (
            <button
              className={`filter-chip${danger ? " danger" : ""}${active ? " active" : ""}`}
              key={key}
              type="button"
              aria-pressed={active}
              title={title}
              onClick={() => onPatchFilters({ [key]: !active })}
            >
              {icon(active)}
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <div className="more-filter" ref={moreFiltersRef}>
        <button
          className={`more-filter-trigger${moreFiltersOpen ? " active" : ""}${adjustedMoreFilters > 0 ? " adjusted" : ""}`}
          type="button"
          aria-expanded={moreFiltersOpen}
          aria-controls="session-more-filter-panel"
          title={text("보관·서브에이전트·AIA 대화·반복 요청 포함 여부", "Include archived, subagents, AIA chats, and scheduled runs")}
          onClick={() => onMoreFiltersOpenChange(!moreFiltersOpen)}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span>{text("추가 필터", "More filters")}</span>
          {adjustedMoreFilters > 0 && <em aria-label={text(`기본값과 다른 항목 ${adjustedMoreFilters}개`, `${adjustedMoreFilters} non-default filters`)}>{adjustedMoreFilters}</em>}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {moreFiltersOpen && (
          <div className="more-filter-panel" id="session-more-filter-panel" role="group" aria-label={text("추가 필터", "More filters")}>
            {moreFilterChecks.map(({ key, label }) => (
              <label className="check-filter" key={key}><input type="checkbox" checked={filters[key]} onChange={(event) => onPatchFilters({ [key]: event.target.checked })} /> {label}</label>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 세션 행의 공급자 표시. 행마다 같은 이름이 수백 번 반복되던 자리라 글자 대신 표식만
 * 세운다. 표식 자체는 `aria-hidden`이라 이름은 감싸는 span이 들고, 마우스에는 툴팁으로
 * 남는다.
 */
function SessionSourceMark({ source }: { source: ProviderId }) {
  const name = sourceName(source);
  return (
    <span className="session-source-mark" role="img" aria-label={name} title={name}>
      <ProviderMark provider={source} size={15} />
    </span>
  );
}

/**
 * 걸러 낸 세션을 그리는 표. 그리는 행 수(`sessions`)와 걸린 전체 수(`total`)를 따로
 * 받는 것은 '더 보기'가 늘려 가는 값이 앞의 것뿐이기 때문이다. 폴더 끌기·우클릭·열기는
 * 목록 화면이 쥔 조작이라 이 표는 손잡이만 받아 건다.
 */
/** 세션 행 제목 셀의 폴더 칩 묶음 (최대 3개) */
function SessionFolderChips({
  folderIds,
  foldersById,
}: {
  folderIds: readonly string[];
  foldersById: Map<string, SessionFolder>;
}) {
  if (folderIds.length === 0) return null;
  return (
    <div className="session-folder-chips">
      {folderIds.slice(0, 3).map((folderId) => {
        const folder = foldersById.get(folderId);
        return folder ? (
          <span
            style={{ "--folder-color": folder.color } as CSSProperties}
            key={folder.id}
            data-user-content
          >
            {folder.name}
          </span>
        ) : null;
      })}
    </div>
  );
}

/** 세션 행의 제목 칸. 즐겨찾기·AIA·실패 뱃지와 최대 3개의 소속 폴더 칩을 함께 그린다. */
function SessionTableTitleCell({
  session,
  foldersById,
}: {
  session: SessionSummary;
  foldersById: Map<string, SessionFolder>;
}) {
  const { text } = useI18n();
  return (
    <div className="title-cell">
      <strong>
        {session.meta.favorite && (
          <span className="favorite-star">
            <Star size={11} fill="currentColor" strokeWidth={0} />
          </span>
        )}
        {session.aiaWorkspace && (
          <span className="session-aia-chip" title={text("AIA 작업공간에서 오간 대화입니다", "Conversation from AIA workspace")}>
            AIA
          </span>
        )}
        {session.lastFailure && (
          <span className="session-failure-chip" title={sessionFailureTitle(session.lastFailure)}>
            {text("실패", "Failed")}
          </span>
        )}
        <span data-user-content>{session.title}</span>
      </strong>
      <SessionFolderChips folderIds={session.meta.folderIds} foldersById={foldersById} />
    </div>
  );
}

interface SessionTableRowProps {
  session: SessionSummary;
  foldersById: Map<string, SessionFolder>;
  isDragging: boolean;
  onOpen: (session: SessionSummary) => void;
  onContextMenu: (session: SessionSummary, x: number, y: number) => void;
  onArmDrag: (session: SessionSummary, event: ReactPointerEvent<HTMLElement>) => void;
}

/** 세션 표의 한 행. 우클릭 좌표 계산과 드래그 착수, 셀 구성을 표 본문에서 분리한다. */
function SessionTableRow({
  session,
  foldersById,
  isDragging,
  onOpen,
  onContextMenu,
  onArmDrag,
}: SessionTableRowProps) {
  const { text } = useI18n();
  const handleContextMenu = (event: React.MouseEvent<HTMLTableRowElement>) => {
    // Shift+우클릭은 WebView의 Reload/Inspect 메뉴가 필요한 개발 흐름에 남겨 둔다.
    if (event.shiftKey) return;
    event.preventDefault();
    const row = event.currentTarget.getBoundingClientRect();
    onContextMenu(session, event.clientX || row.left + 24, event.clientY || row.top + 24);
  };

  return (
    <tr
      className={isDragging ? "is-dragging" : ""}
      onContextMenu={handleContextMenu}
      onClick={() => onOpen(session)}
      onPointerDown={(event: ReactPointerEvent<HTMLTableRowElement>) => onArmDrag(session, event)}
    >
      <td>
        <span className="session-source-cell">
          <span className="drag-grip" title={text("폴더로 드래그", "Drag to folder")}>
            <GripVertical size={13} />
          </span>
          <SessionSourceMark source={session.source} />
        </span>
      </td>
      <td>
        <SessionTableTitleCell session={session} foldersById={foldersById} />
      </td>
      <td>
        <div className="project-cell" data-user-content>
          <span className="cell-main">{session.project ? displayPath(session.project) : "–"}</span>
          <small title={session.cwd ? displayPath(session.cwd) : undefined}>{session.gitBranch ?? ""}</small>
        </div>
      </td>
      <td><code>{session.model ?? "–"}</code></td>
      <td>{session.messageCount?.toLocaleString() ?? "–"}</td>
      <td>{formatTokens(session.tokenTotal)}</td>
      <td title={formatDate(session.updatedAt)}>{formatRelative(session.updatedAt)}</td>
    </tr>
  );
}

function SessionTable({
  sessions,
  total,
  folders,
  draggedSession,
  onOpen,
  onContextMenu,
  onArmDrag,
  onLoadMore,
}: {
  sessions: SessionSummary[];
  total: number;
  folders: SessionFolder[];
  draggedSession: SessionSummary | null;
  onOpen: (session: SessionSummary) => void;
  onContextMenu: (session: SessionSummary, x: number, y: number) => void;
  onArmDrag: (session: SessionSummary, event: ReactPointerEvent<HTMLElement>) => void;
  onLoadMore: () => void;
}) {
  const { text } = useI18n();
  const foldersById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );

  return (
    <section className="panel table-panel">
      <div className="table-caption">
        <strong>{text(`세션 ${total.toLocaleString()}개`, `${total.toLocaleString()} sessions`)}</strong>
        <span>{text("행을 폴더로 드래그해 분류하거나, 선택해서 대화 내역을 확인하세요.", "Drag rows into folders to organize, or select to view conversation history.")}</span>
      </div>
      {total === 0 ? (
        <EmptyState title={text("조건에 맞는 세션이 없습니다", "No matching sessions")} detail={text("필터를 바꾸거나 새로고침해 보세요.", "Try changing filters or refreshing.")} />
      ) : (
        <div className="table-scroll">
          <table className="data-table session-table">
            <thead>
              <tr><th>{text("소스", "Source")}</th><th>{text("제목", "Title")}</th><th>{text("프로젝트", "Project")}</th><th>{text("모델", "Model")}</th><th>{text("메시지", "Messages")}</th><th>{text("토큰", "Tokens")}</th><th>{text("업데이트", "Updated")}</th></tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionTableRow
                  key={sessionKey(session.source, session.id)}
                  session={session}
                  foldersById={foldersById}
                  isDragging={draggedSession !== null && sameSessionIdentity(draggedSession, session)}
                  onOpen={onOpen}
                  onContextMenu={onContextMenu}
                  onArmDrag={onArmDrag}
                />
              ))}
            </tbody>
          </table>
          {sessions.length < total && (
            <div className="session-table-more">
              <button className="button" type="button" onClick={onLoadMore}>
                {text("더 보기", "Show more")} · {sessions.length} / {total}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
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

/** 메뉴가 화면 밖으로 밀려 나지 않게 남기는 여백. */
const SESSION_CONTEXT_MENU_MARGIN = 8;

/** 메뉴 안에서 초점을 받을 수 있는 항목. 접기·펴기 없이 버튼만 늘어서는 메뉴다. */
const SESSION_CONTEXT_MENU_ITEMS = "button:not(:disabled)";

/**
 * 우클릭 메뉴가 뜬 자리에 눌러앉기 위한 거동 한 벌 — 화면 안으로 접어 넣는 위치, 첫 항목
 * 초점, 닫는 네 경로(Esc · 바깥 눌림 · 뒤쪽 화면 스크롤 · 창 크기 변경), 방향키 초점 이동.
 * 이 다섯은 메뉴가 그리는 내용과 무관하게 "떠 있는 메뉴라면 늘 같은" 규칙인데 마크업과 한
 * 몸으로 붙어 있어, 항목을 늘리거나 문구를 고치는 변경이 매번 이 규칙들을 헤집고 지나가야
 * 했다. 규칙은 여기 두고, 컴포넌트는 붙일 손잡이 셋만 받는다.
 */
function useSessionContextMenuPopup(anchorX: number, anchorY: number, onClose: () => void): {
  menuRef: RefObject<HTMLDivElement | null>;
  position: { left: number; top: number };
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
} {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: anchorX, top: anchorY });

  useEscapeToClose(onClose);
  useOutsidePointerToClose(onClose, true, [menuRef]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = SESSION_CONTEXT_MENU_MARGIN;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(margin, Math.min(anchorX, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(anchorY, window.innerHeight - rect.height - margin)),
    });
    menu.querySelector<HTMLButtonElement>(SESSION_CONTEXT_MENU_ITEMS)?.focus();
  }, [anchorX, anchorY]);

  useEffect(() => {
    const closeOnOutsideScroll = (event: Event) => {
      const target = event.target;
      // scroll은 버블링하지 않지만 캡처 단계에서는 메뉴 내부 목록의 스크롤도 window에
      // 도달한다. 폴더를 훑는 정상 동작은 유지하고, 뒤쪽 화면이 움직일 때만 닫는다.
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", closeOnOutsideScroll, true);
    return () => {
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", closeOnOutsideScroll, true);
    };
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>(SESSION_CONTEXT_MENU_ITEMS) ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return { menuRef, position, onKeyDown };
}

function SessionContextMenu({ session, folders, anchorX, anchorY, onClose, onOpen, onOpenPopout, onToggleFavorite, onChooseFolder, onToggleArchived }: SessionContextMenuProps) {
  const { text } = useI18n();
  const { menuRef, position, onKeyDown } = useSessionContextMenuPopup(anchorX, anchorY, onClose);

  return createPortal(
    <div
      className="session-context-menu"
      ref={menuRef}
      role="menu"
      aria-label={text(`${session.title} 세션 기능`, `${session.title} session actions`)}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
    >
      <header>
        <SourceBadge source={session.source} />
        <strong>{session.title}</strong>
      </header>
      <button type="button" role="menuitem" onClick={onOpen}><ScrollText size={14} /> {text("세션 열기", "Open session")}</button>
      <button type="button" role="menuitem" onClick={onOpenPopout}><AppWindow size={14} /> {text("새 창으로 열기", "Open in new window")}</button>
      <button type="button" role="menuitem" onClick={onToggleFavorite}>
        <Star size={14} fill={session.meta.favorite ? "currentColor" : "none"} />
        {session.meta.favorite ? text("즐겨찾기 해제", "Remove from favorites") : text("즐겨찾기 추가", "Add to favorites")}
      </button>
      <SessionContextFolderChoices folders={folders} folderIds={session.meta.folderIds} onChoose={onChooseFolder} />
      <div className="session-context-separator" />
      <button className="archive" type="button" role="menuitem" onClick={onToggleArchived}>
        {session.meta.hidden ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        {session.meta.hidden ? text("보관 해제", "Unarchive") : text("보관", "Archive")}
      </button>
      <small>{text("공급자 세션 원본은 변경하지 않습니다.", "Provider session source is not modified.")}</small>
    </div>,
    document.body,
  );
}

/**
 * 우클릭 메뉴 안의 폴더 지정 목록. '미분류'와 폴더 하나하나가 같은 체크 항목이라 담긴
 * 상태·체크 표시·접근성 속성이 세 쌍으로 붙어 다니는데, 메뉴 마크업 한복판에 있어 어느
 * 버튼이 무엇을 켜고 끄는지가 다른 메뉴 항목들 사이에 묻혀 있었다. 목록 자체가 세로로
 * 스크롤되는 구역이라 휠도 여기서 삼켜 뒤쪽 화면이 함께 밀리지 않게 한다.
 */
function SessionContextFolderChoices({ folders, folderIds, onChoose }: {
  folders: SessionFolder[];
  folderIds: string[];
  onChoose: (folderId: string | null) => void | Promise<void>;
}) {
  const { text } = useI18n();
  const unfiled = folderIds.length === 0;
  return (
    <section className="session-context-folders" aria-label={text("폴더 지정", "Assign folder")}>
      <span><Folder size={13} /> {text("폴더 지정", "Assign folder")}</span>
      <div onWheel={(event) => event.stopPropagation()}>
        <button className={unfiled ? "selected" : ""} type="button" role="menuitemcheckbox" aria-checked={unfiled} onClick={() => onChoose(null)}>
          <i className="folder-unfiled-dot" /> {text("미분류", "Unfiled")}
          {unfiled && <Check size={12} />}
        </button>
        {folders.map((folder) => {
          const selected = folderIds.includes(folder.id);
          return <button
            className={selected ? "selected" : ""}
            style={{ "--folder-color": folder.color } as CSSProperties}
            type="button"
            role="menuitemcheckbox"
            aria-checked={selected}
            title={folderPathLabel(folders, folder.id)}
            key={folder.id}
            onClick={() => onChoose(folder.id)}
          >
            <i /> <span>{folderPathLabel(folders, folder.id)}</span>
            {selected && <Check size={12} />}
          </button>;
        })}
      </div>
    </section>
  );
}

/**
 * 목록이 언제 기준인지 알리는 배너. 정상이면 아무것도 그리지 않는다.
 *
 * 스냅샷 읽기는 갱신이 멈춰도 성공하므로, 목록만 봐서는 굳었는지 알 수 없다.
 */
function CatalogHealthBanner({ health, onRefresh }: { health: CatalogHealth | null; onRefresh?: () => void }) {
  const { text } = useI18n();
  const notice = catalogHealthNotice(health, Date.now());
  if (!notice) return null;
  return (
    <div className={`catalog-health-banner is-${notice.tone}`} role="status">
      <div>
        <strong>{notice.headline}</strong>
        {notice.detail && <small>{notice.detail}</small>}
      </div>
      {onRefresh && <button className="button secondary" type="button" onClick={onRefresh}>{text("지금 갱신", "Refresh now")}</button>}
    </div>
  );
}

/** 반복 실행이 소유한 런타임에서 실행을 끊는 조작을 막을 때 보여 줄 이유. */
const UNATTENDED_RUNTIME_LOCK_MESSAGE =
  runtimeText(
    "반복 실행이 이 세션을 사용 중입니다. 실행 설정과 공급자는 이 실행이 끝난 뒤에 바꿀 수 있습니다.",
    "A scheduled run is using this session. Run settings and provider can be changed after this run completes.",
  );

/**
 * 이어가기가 보는 실행 단계. 붙은 실행이 알려주는 `ChatPhase`에, 아직 실행이 없는
 * `idle`과 연결을 세우는 중인 `connecting` 둘이 더 붙는다. 네 자리가 이 합집합을
 * 손으로 적고 있어 한 곳만 늘리면 나머지가 조용히 어긋났다.
 */
type ContinuationPhase = ChatPhase | "idle" | "connecting";

/** 붙어 있는 실행이 없는 상태. stopped·failed는 상태 이벤트를 받을 때 이미 연결을 놓았다. */
function isDetachedPhase(phase: ContinuationPhase): boolean {
  return phase === "idle" || phase === "stopped" || phase === "failed";
}

/**
 * 붙어 있는 실행이 아직 답을 만들고 있는 상태. 이 사이에 설정을 바꾸거나 연결을 끊으면
 * 진행 중인 요청이 통째로 사라진다.
 *
 * 훅은 `responding`, 작성기는 `busy`라는 다른 이름으로 같은 조건을 각각 적고 있었다.
 * 이름이 갈려 있으면 승인 대기를 응답 중으로 볼지 같은 판단이 두 자리에서 따로 흔들린다.
 */
function isRespondingPhase(phase: ContinuationPhase): boolean {
  return phase === "running" || phase === "waitingApproval";
}

/** 연결을 세우는 중이거나 응답 중이라, 실행을 갈아 끼우는 조작을 받을 수 없는 상태. */
function isBusyPhase(phase: ContinuationPhase): boolean {
  return phase === "connecting" || isRespondingPhase(phase);
}

/** 이어갈 수 없는 이유. 작성창에 띄울 짧은 문구와 전송을 되돌릴 때 남길 문장을 함께 든다. */
interface ContinuationBlock {
  reason: string;
  detail: string;
}

/**
 * 이 세션을 이어갈 경로, 또는 이어갈 수 없는 이유.
 *
 * 같은 두 조건(작업 경로 없음·서브에이전트)을 파일을 받지 않는 자리, 작성창을 막는 자리,
 * 전송을 되돌리는 자리가 각각 적고 있었고 문구도 두 벌로 갈라져 있었다. 한쪽만 고치면
 * 놓을 수는 있는데 보내면 거절되는(또는 그 반대의) 화면이 되므로 판정과 문구를 한 벌로
 * 둔다. 막히지 않았을 때만 경로가 실려 나오므로, 부르는 쪽은 경로 유무를 다시 보지 않는다.
 */
type ContinuationTarget =
  | { cwd: string; blocked: null }
  | { cwd: null; blocked: ContinuationBlock };

// 세션 색인에 경로가 없어도 붙은 실행이 알려준 경로로 이어갈 수 있다.
function continuationTarget(session: SessionSummary, attachedCwd: string | null): ContinuationTarget {
  const cwd = session.cwd ?? attachedCwd;
  if (!cwd) {
    return {
      cwd: null,
      blocked: {
        reason: runtimeText("작업 경로가 없어 이어갈 수 없습니다", "Cannot continue without working directory"),
        detail: runtimeText("세션에 저장된 작업 경로가 없어 대화를 이어갈 수 없습니다.", "Cannot continue conversation because no working directory is saved in the session."),
      },
    };
  }
  if (session.isSubagent) {
    return {
      cwd: null,
      blocked: {
        reason: runtimeText("서브에이전트 세션은 이어갈 수 없습니다", "Cannot continue subagent session"),
        detail: runtimeText("서브에이전트 세션은 직접 이어가기 대상이 아닙니다.", "Subagent sessions cannot be continued directly."),
      },
    };
  }
  return { cwd, blocked: null };
}

/** 이어보내기 실행을 다시 띄우게 만드는 설정 다섯 칸. 이 벌이 같으면 실행도 그대로 둔다. */
interface ContinuationSettings {
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  extraSettings: Record<string, string>;
}

/**
 * 이 벌을 세우는 자리는 셋이다 — 공급자를 바꿔 처음으로 되돌릴 때, 드로어를 열며 세션
 * 메타에 남은 값으로 시작할 때, 붙은 실행이 알려 준 값으로 덮을 때. 셋이 600줄 떨어진
 * 자리에서 다섯 칸을 각각 늘어놓고 있어, 칸이 하나 늘면 어느 자리가 빠졌는지 눈으로
 * 세야 했고 빠진 자리는 `undefined`가 아니라 조용히 옛 값을 남기는 쪽으로 어긋났다.
 * 다섯 칸을 채우는 규칙은 여기 셋만 두고, 부르는 쪽은 무엇을 근거로 세우는지만 고른다.
 */
function defaultContinuationSettings(source: ProviderId): ContinuationSettings {
  return {
    mode: "workspace",
    approvalMode: defaultApprovalMode(source),
    model: "",
    reasoningEffort: "",
    extraSettings: {},
  };
}

/** 드로어를 열 때의 시작값. 세션에 남은 값을 쓰고, 없는 칸만 기본값으로 메운다. */
function sessionContinuationSettings(session: SessionSummary): ContinuationSettings {
  const base = defaultContinuationSettings(session.source);
  return {
    ...base,
    mode: session.meta.mode ?? base.mode,
    approvalMode: session.meta.approvalMode ?? base.approvalMode,
    model: session.model ?? base.model,
    reasoningEffort: session.meta.reasoningEffort ?? base.reasoningEffort,
  };
}

/** 붙은 실행이 알려 준 값. 추가 설정까지 실행 쪽이 정본이므로 다섯 칸을 모두 덮는다. */
function connectionContinuationSettings(info: ChatConnection["info"]): ContinuationSettings {
  return {
    mode: info.mode,
    approvalMode: info.approvalMode,
    model: info.model ?? "",
    reasoningEffort: info.reasoningEffort ?? "",
    extraSettings: info.settings ?? {},
  };
}

function sameContinuationSettings(a: ContinuationSettings, b: ContinuationSettings): boolean {
  return a.mode === b.mode
    && a.approvalMode === b.approvalMode
    && a.model === b.model
    && a.reasoningEffort === b.reasoningEffort
    && sameChatSettings(a.extraSettings, b.extraSettings);
}


/**
 * 세션 메타를 고치는 한 벌. 값·저장 중 표시·고치는 손잡이 셋은 언제나 함께 쓰이는데,
 * 설정 판과 그 아래 구역 넷이 이 셋을 낱개 prop으로 다시 풀어 받고 있었다. 구역을 하나
 * 늘릴 때마다 같은 세 줄을 선언·전달 두 자리에 또 적어야 했고, `saving`만 빠뜨린 구역은
 * 저장 중에도 눌리는 채로 남는다. 이름을 붙여 한 벌로 들고 다닌다.
 */
interface SessionMetaEditor {
  meta: SessionMeta;
  /** 저장 왕복이 도는 중. 값을 바꾸는 칸은 이 동안 잠근다. */
  saving: boolean;
  patchMeta: (patch: Partial<SessionMeta>) => Promise<void>;
}

/**
 * 드로어가 들고 있는 세션 메타와 그 수정. 별표·보관 같은 토글은 서버 왕복 위에 메타데이터
 * 파일을 통째로 다시 쓰는 작업이 얹혀 있어 화면을 먼저 바꾸고 실패했을 때만 되돌린다.
 * 그 낙관 갱신에는 값·저장 표시·세대 번호·prop 재동기화가 한 벌로 따라붙는데, 1000줄짜리
 * 드로어 본문 안에서는 네 조각이 멀찍이 흩어져 있었다. 한 자리에 모아 드로어는 결과만 쓴다.
 */
function useOptimisticSessionMeta(
  session: SessionSummary,
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void,
  onError: (message: string | null) => void,
): SessionMetaEditor {
  const [meta, setMeta] = useState(session.meta);
  const [saving, setSaving] = useState(false);
  // 낙관 갱신한 메타를 뒤늦게 도착한 앞선 요청의 응답이 되돌리지 못하게 하는 세대 번호.
  const revisionRef = useRef(0);
  useEffect(() => setMeta(session.meta), [session.meta]);

  const patchMeta = async (patch: Partial<SessionMeta>) => {
    const previous = meta;
    // 연속으로 누르면 응답 순서가 뒤바뀔 수 있어, 마지막 요청의 응답만 반영하고 그 요청이
    // 실패했을 때만 되돌린다. 세대가 밀린 요청은 값도 사유도 남기지 않으므로, 저장 절차가
    // 부르는 두 자리를 같은 판정으로 감싼다(낙관 값은 세대를 막 올린 직후라 언제나 통과).
    revisionRef.current += 1;
    const revision = revisionRef.current;
    const current = () => revisionRef.current === revision;
    setSaving(true);
    try {
      await saveSessionMetaPatch(session.source, session.id, previous, patch, (next) => {
        if (!current()) return;
        setMeta(next);
        // 목록 행의 별표도 같이 바꿔야 한다. 이 값이 세션 스냅샷을 거쳐 prop으로 돌아오므로,
        // 폴링이 끼어들어도 화면 두 곳이 서로 다른 상태로 갈라지지 않는다.
        onMetaChanged(session.source, session.id, next);
      }, (message) => { if (current()) onError(message); });
    } finally {
      if (current()) setSaving(false);
    }
  };

  return { meta, saving, patchMeta };
}

/**
 * 드로어 머리의 '세션 설정' 펼침 판. 펼침 여부 하나에 토글 버튼·판 요소의 ref, Esc와
 * 바깥 클릭으로 닫기, 그리고 펼쳤을 때 한 번만 읽는 이 공급자의 계정 목록이 모두 매달려
 * 있는데 드로어 본문의 다섯 자리에 흩어져 있었다. 닫는 길이 세 갈래(토글·Esc·바깥
 * 클릭)라 어느 하나가 ref 짝을 빠뜨리거나 계정 조회 조건과 어긋나면 판이 닫히지 않거나
 * 닫을 때마다 계정을 다시 읽는다. 한 훅에 모아 그 짝을 한 자리에서만 맞춘다.
 */
/** 세션 설정 판의 열림 상태 한 벌. 여는 버튼과 판 자체가 나뉘어 있어 이름을 붙여 들고 다닌다. */
interface SessionSettingsPanel {
  expanded: boolean;
  toggle: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
  /** 실행 계정 고정 선택에 쓰는 이 공급자의 계정 목록. 판을 펼칠 때만 읽는다. */
  accounts: ProviderAccountView[] | null;
}

function useSessionSettingsPanel(source: ProviderId): SessionSettingsPanel {
  const [expanded, setExpanded] = useState(false);
  const [accounts, setAccounts] = useState<ProviderAccountView[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded || accounts) return undefined;
    let cancelled = false;
    void getProviderAccounts()
      .then((snapshot) => {
        if (!cancelled) setAccounts(snapshot.accounts.filter((account) => account.provider === source));
      })
      .catch(() => { if (!cancelled) setAccounts([]); });
    return () => { cancelled = true; };
  }, [expanded, accounts, source]);

  useEscapeToClose(() => setExpanded(false), expanded);
  useOutsidePointerToClose(() => setExpanded(false), expanded, [panelRef, toggleRef]);

  return {
    expanded,
    toggle: useCallback(() => setExpanded((current) => !current), []),
    panelRef,
    toggleRef,
    accounts,
  };
}

/**
 * 세션 상세 서랍의 탭. 탭마다 고르는 값·아이콘·이름을 세 자리(상태 타입, 탭 줄, 본문
 * 분기)에 따로 적고 있어 하나를 더하거나 고칠 때 한 자리만 고치면 조용히 어긋났다.
 * 고르는 값은 이 표에서 뽑고, 탭 줄은 이 표를 그대로 그린다.
 */
const SESSION_DRAWER_TAB_KEYS = ["conversation", "activity", "terminal"] as const;

type SessionDrawerTab = (typeof SESSION_DRAWER_TAB_KEYS)[number];

function sessionDrawerTabs(text: UiText): readonly { id: SessionDrawerTab; label: string; Icon: LucideIcon }[] {
  return [
    { id: "conversation", label: text("대화", "Conversation"), Icon: MessagesSquare },
    { id: "activity", label: text("작업 로그", "Activity log"), Icon: ScrollText },
    { id: "terminal", label: text("터미널", "Terminal"), Icon: SquareTerminal },
  ];
}

/** 대화 원문 구역이 맡는 탭. 터미널 탭은 원문 대신 터미널을 그려 여기로 오지 않는다. */
type SessionTranscriptTab = Exclude<SessionDrawerTab, "terminal">;

/**
 * 다음 페인트에 자리 옮기기를 한 번 예약하고, 그 예약을 걷는 정리 함수를 돌려준다.
 *
 * 드로어가 본문 자리를 옮기는 세 갈래(최초 위치 잡기 · 최신 따라가기 · 새 요청 자리로
 * 옮기기)가 저마다 `requestAnimationFrame`으로 걸고 정리 쪽에서 `cancelAnimationFrame`으로
 * 걷는 같은 짝을 풀어 적고 있었다. 한 자리에서 걷기를 빠뜨리면 다른 세션이나 다른 표시
 * 범위로 옮겨 간 뒤에 옛 예약이 깨어나 방금 연 화면을 엉뚱한 자리로 끌어내린다. 예약과
 * 걷기의 짝은 여기 한 벌만 두고, 갈래마다 다른 것은 옮길 자리 하나만 남긴다.
 *
 * 세 갈래가 모두 프레임을 기다리는 이유는 같다 — 새로 그린 항목의 배치가 끝난 뒤여야
 * `scrollHeight`와 마지막 사용자 메시지의 위치가 실제 값이다.
 */
function scheduleScrollFrame(move: () => void): () => void {
  const frame = window.requestAnimationFrame(move);
  return () => window.cancelAnimationFrame(frame);
}

/** 본문을 맨 아래에 붙인다. 자리를 잡는 이동이라 애니메이션 없이 곧바로 옮긴다. */
function scrollBodyToEnd(body: HTMLElement) {
  body.scrollTo({ top: body.scrollHeight, behavior: "auto" });
}

/**
 * 세션 상세 본문의 스크롤 위치를 표시 방식에 맞춰 잡는다. 처음 열 때 어디에 서는지,
 * 응답이 이어질 때 바닥을 따라갈지, 새로 보낸 메시지를 맨 위로 올릴지는 서로 다른
 * 시점에 걸리지만 모두 "본문을 어디에 두는가" 하나를 두고 세 개의 기억(최초 적용 여부·
 * 따라가기 여부·이미 올린 메시지)을 공유한다. 드로어 본문에 흩어져 있으면 그 기억을
 * 누가 언제 되돌리는지 읽히지 않으므로 한 훅에 모은다. 본문 요소는 원문 훅과 화면이
 * 함께 쓰므로 여기서 만들지 않고 받아 쓴다.
 */
function useSessionDrawerScroll({
  bodyRef,
  sessionId,
  sessionSource,
  transcriptLimit,
  messageDisplayMode,
  activeTab,
  detail,
  continuationTurns,
  onBeforeJump,
}: {
  bodyRef: RefObject<HTMLDivElement | null>;
  sessionId: string;
  sessionSource: ProviderId;
  transcriptLimit: SessionTranscriptLimit;
  messageDisplayMode: MessageDisplayMode;
  activeTab: SessionDrawerTab;
  detail: SessionDetail | null;
  continuationTurns: ChatTurn[];
  /** 화면을 새 요청 자리로 옮기기 직전에 부른다. 읽던 자리는 그 시점에만 남아 있다. */
  onBeforeJump: () => void;
}): { pauseFollowingLatestMessages: () => void; resumeFollowingLatestMessages: () => void } {
  const initialPositionAppliedRef = useRef(false);
  const followLatestMessagesRef = useRef(messageDisplayMode === "latest");
  const handledContinuationUserMessageRef = useRef<string | null>(null);

  // 다른 세션이나 다른 표시 범위를 열면 최초 위치를 다시 잡아야 한다.
  useEffect(() => {
    initialPositionAppliedRef.current = false;
    handledContinuationUserMessageRef.current = null;
  }, [sessionSource, sessionId, transcriptLimit]);

  useEffect(() => {
    followLatestMessagesRef.current = messageDisplayMode === "latest";
  }, [messageDisplayMode, sessionId]);

  const pauseFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = false;
  }, []);
  const resumeFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = messageDisplayMode === "latest";
  }, [messageDisplayMode]);

  useEffect(() => {
    if (messageDisplayMode === "start" || initialPositionAppliedRef.current || activeTab !== "conversation" || !detail) return undefined;
    initialPositionAppliedRef.current = true;
    return scheduleScrollFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      // '마지막 보낸 메시지부터' 모드는 마지막 사용자 메시지를 화면 맨 위에 두고,
      // 사용자 메시지가 없으면(세션 정보만 있는 경우) 맨 아래로 대신 이동한다.
      if (messageDisplayMode === "latest" || !scrollToLastUserMessage(body)) scrollBodyToEnd(body);
    });
  }, [bodyRef, activeTab, messageDisplayMode, detail]);

  useEffect(() => {
    if (messageDisplayMode !== "latest" || !followLatestMessagesRef.current || activeTab !== "conversation" || continuationTurns.length === 0) return undefined;
    return scheduleScrollFrame(() => {
      if (!followLatestMessagesRef.current) return;
      const body = bodyRef.current;
      if (body) scrollBodyToEnd(body);
    });
  }, [bodyRef, activeTab, messageDisplayMode, continuationTurns]);

  // '마지막 보낸 메시지부터' 모드: 이어가기 입력으로 새 메시지를 보내면 그 메시지가
  // 화면 맨 위에 오도록 이동한다. 같은 메시지는 다시 이동하지 않는다.
  const continuationLastUserMessageId = useMemo(() => lastUserMessageKey(continuationTurns), [continuationTurns]);
  useEffect(() => {
    if (messageDisplayMode !== "lastUser" || activeTab !== "conversation" || !continuationLastUserMessageId) return undefined;
    if (handledContinuationUserMessageRef.current === continuationLastUserMessageId) return undefined;
    return scheduleScrollFrame(() => {
      // 읽다 만 자리를 잃는 지점이 여기다. 옮기기 전에 그 자리를 챙겨 둔다.
      onBeforeJump();
      if (scrollToLastUserMessage(bodyRef.current)) {
        handledContinuationUserMessageRef.current = continuationLastUserMessageId;
      }
    });
  }, [bodyRef, activeTab, messageDisplayMode, continuationLastUserMessageId, onBeforeJump]);

  return { pauseFollowingLatestMessages, resumeFollowingLatestMessages };
}

/**
 * 이미 멈춘 실행의 연결을 놓는다. detach가 실패해도 그 실행은 끝난 상태라 남겨 두어도
 * 안전하므로, 놓는 자리마다 같은 손처리를 되풀이하지 않는다.
 */
async function detachStoppedConnection(connection: ChatConnection) {
  try { await connection.detach(); } catch { /* The stopped provider process is safe to leave detached. */ }
}

/** 이어가기 연결의 소유권 한 벌. 상태 반영(단계·대기열·오류)은 부르는 쪽 몫이다. */
interface ContinuationConnectionOwnership {
  connectionRef: RefObject<ChatConnection | null>;
  generationRef: RefObject<number>;
  appliedStateGenerationRef: RefObject<number>;
  attachedCwd: string | null;
  nextGeneration: () => number;
  take: () => ChatConnection | null;
  adopt: (connection: ChatConnection) => void;
  claimSessionSync: (source: ProviderId, providerSessionId: string) => boolean;
}

/**
 * 이어가기 연결을 누가 들고 있는지만 맡는 한 벌. 연결 ref·세대 번호·붙은 실행이 알려준
 * 작업 경로·색인에 알린 세션 집합은 언제나 같이 움직이는데, 이것들이 드로어 본문의
 * state 선언 사이에 흩어져 있어 한 자리에서 세대만 올리고 ref를 비우지 않는 식으로
 * 어긋나기 쉬웠다. 소유권을 옮기는 네 조작(세대 올리기·떼어 내기·맡기·색인 표시)을
 * 그 값들과 같은 자리에 둬 서로 어긋날 곳을 없앤다.
 */
function useContinuationConnection(ownerSessionKey: string): ContinuationConnectionOwnership {
  // Antigravity처럼 세션 색인에 작업 경로가 없는 공급자는 실행 중 채팅에 붙고 나서야
  // 경로를 알 수 있다. 붙은 실행이 알려준 경로를 기억해 이어가기 입력을 열어 둔다.
  const [attachedCwd, setAttachedCwd] = useState<string | null>(null);
  const connectionRef = useRef<ChatConnection | null>(null);
  const generationRef = useRef(0);
  /** 이 연결에서 실제 state 이벤트를 반영한 세대. attach 응답의 낡은 스냅숏을 가려낸다. */
  const appliedStateGenerationRef = useRef(-1);
  const syncedSessionsRef = useRef(new Set<string>());

  useEffect(() => {
    setAttachedCwd(null);
  }, [ownerSessionKey]);

  // 이어가기 연결을 새로 띄우거나 놓아주는 자리는 여러 곳이다(드로어 종료, 재연결, 첫
  // 전송, 공급자 교체, 실행 설정 변경). 세대 번호를 올려 옛 연결의 이벤트를 버리는 일과
  // ref를 비우는 일이 한 곳에서라도 어긋나면 끊긴 실행의 이벤트가 새 연결 화면에 섞이므로
  // 한 벌로 모은다.
  const nextGeneration = useCallback(() => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);
  /** 붙어 있던 연결을 이 화면에서 떼어 내고 넘겨준다. 종료·detach는 부르는 쪽이 맡는다. */
  const take = useCallback(() => {
    nextGeneration();
    const connection = connectionRef.current;
    connectionRef.current = null;
    return connection;
  }, [nextGeneration]);
  /**
   * 새로 얻은 연결을 이 화면이 맡는다. 세션 색인에 경로가 없는 공급자는 붙은 실행이
   * 알려준 경로로만 이어갈 수 있어, 연결을 들고 있는 일과 그 경로를 기억하는 일은
   * 언제나 같이 일어난다. 뒤이은 상태 반영은 갈래마다 달라 부르는 쪽이 맡는다.
   */
  const adopt = useCallback((connection: ChatConnection) => {
    connectionRef.current = connection;
    setAttachedCwd(connection.info.cwd || null);
  }, []);
  /**
   * 이 공급자 세션을 색인에 알렸다고 표시하고 이번이 처음인지 돌려준다. 연결을 얻는 자리와
   * state 이벤트가 각자 같은 키를 만들어 같은 집합에 넣고 있어, 키 모양이 한쪽에서만
   * 바뀌면 같은 세션을 두 번 알리거나 영영 알리지 못한다. 그 모양은 `sessionKey`가 정한다.
   */
  const claimSessionSync = useCallback((source: ProviderId, providerSessionId: string): boolean => {
    const key = sessionKey(source, providerSessionId);
    if (syncedSessionsRef.current.has(key)) return false;
    syncedSessionsRef.current.add(key);
    return true;
  }, []);

  return { connectionRef, generationRef, appliedStateGenerationRef, attachedCwd, nextGeneration, take, adopt, claimSessionSync };
}

/** 이어가기 화면이 아는 컨텍스트 크기. 붙어 있는 실행이 알려 준 값만 담는다. */
interface ContinuationContextSize {
  used: number | null;
  window: number | null;
}

const EMPTY_CONTINUATION_CONTEXT: ContinuationContextSize = { used: null, window: null };

/**
 * 붙어 있는 실행이 알려 주는 컨텍스트 크기 한 벌. 채우는 자리(상태 이벤트)와 비우는 두
 * 자리(공급자 교체·세션 전환)가 각각 `{ used: null, window: null }` 리터럴을 따로 적고
 * 있어, 한 칸을 늘릴 때 어느 자리가 빠졌는지 눈으로 세야 했다. 비움의 정의를 여기 하나로
 * 두고 바깥에는 채우기·비우기 두 동작만 낸다.
 */
function useContinuationContextSize(): {
  context: ContinuationContextSize;
  applyLive: (used: number | null, window: number | null) => void;
  clear: () => void;
} {
  const [context, setContext] = useState<ContinuationContextSize>(EMPTY_CONTINUATION_CONTEXT);
  const applyLive = useCallback(
    (used: number | null, window: number | null) => setContext({ used, window }),
    [],
  );
  const clear = useCallback(() => setContext(EMPTY_CONTINUATION_CONTEXT), []);
  return { context, applyLive, clear };
}

/** 원문 파일에 남은 마지막 사용량. 라이브 실행이 아니라 원본 세션의 크기다. */
function historicalContextUsedTokens(detail: SessionDetail | null): number | null {
  const usage = [...(detail?.transcript ?? [])].reverse().find((item) => item.usage)?.usage;
  return usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
}

/**
 * 화면에 보일 컨텍스트 사용량. 파일에 남은 사용량은 원본 세션의 것이라, 붙어 있는 실행이
 * 아직 크기를 알리기 전(압축 직후 포함)에 그 값으로 메우면 남의 세션 크기를 보여 주게
 * 된다. 그래서 실행이 붙어 있지 않을 때만 파일 값으로 메운다.
 */
function displayedContextUsedTokens(
  context: ContinuationContextSize,
  historical: number | null,
  detached: boolean,
): number | null {
  return detached ? context.used ?? historical : context.used;
}

/**
 * 컨텍스트가 큰 상태로 계속 밀고 갈 때의 대가를 알린다. CLI가 한계 근처에서 자동
 * 압축을 하므로 대화가 끊기지는 않지만, 압축은 도구 출력과 파일 원문을 요약으로
 * 바꿔 놓고 되돌릴 수 없다. 그래서 "곧 멈춘다"가 아니라 "지금 넘기면 무엇을 고를 수
 * 있는지"를 말한다. 이미 인계를 고른 상태면 권할 것이 없어 띄우지 않는다.
 */
function largeContextWarningText(
  context: ContinuationContextSize,
  historical: number | null,
  detached: boolean,
  agentHandoffPending: boolean,
): string | null {
  if (agentHandoffPending) return null;
  if (context.used !== null && context.window !== null
    && context.window > 0
    && context.used / context.window >= 0.8) {
    const percent = Math.round((context.used / context.window) * 100);
    return runtimeText(
      `현재 컨텍스트가 ${percent}% 사용되었습니다. 한계에 닿으면 CLI가 자동 압축해 도구 출력·파일 원문이 요약으로 대체됩니다. 그 전에 세션 설정의 '새 세션으로 인계'를 쓰면 필요한 문맥만 골라 넘길 수 있습니다.`,
      `Context is currently ${percent}% full. When the limit is reached, CLI auto-compacts and replaces tool output and file contents with summaries. You can hand off to a new session in session settings beforehand to pass only necessary context.`,
    );
  }
  // 파일에 남은 마지막 사용량은 원본 세션의 것이다. 라이브 실행이 붙어 있으면 그
  // 실행이 이어갈 크기가 아니므로(인계로 갓 만든 새 세션일 수도 있다) 쓰지 않는다.
  if (detached
    && historical !== null
    && historical >= 600_000) {
    const tokens = formatTokens(historical);
    return runtimeText(
      `최근 입력 컨텍스트가 ${tokens}입니다. 재개하면 이 크기에서 시작해 곧 자동 압축에 닿습니다. 세션 설정의 '새 세션으로 인계'로 넘기는 편이 낫습니다.`,
      `Recent input context is ${tokens}. Resuming will start from this size and reach auto-compaction soon. It is recommended to hand off to a new session in session settings.`,
    );
  }
  return null;
}

/**
 * 세션 상세의 '이어가기' 실행 한 벌. 상태 스물, 효과 넷, 조작 열다섯이 서랍 본문에
 * 그대로 늘어서 있어, 화면을 그리는 일(탭·설정 패널·원문 구역)과 실행을 붙였다 떼는
 * 일이 같은 함수 안에서 600줄 넘게 뒤섞여 있었다. 둘은 고치는 이유가 전혀 다르다 —
 * 실행 쪽은 연결·세대·대기열의 순서를 지키는 일이고, 화면 쪽은 무엇을 어디에 그릴지다.
 *
 * 그래서 실행 한 벌만 이 훅으로 내린다. 서랍에 남기는 것은 이 훅이 돌려준 값을 화면에
 * 꽂는 일뿐이다. 화면 쪽 사정이 실행에 닿아야 하는 두 자리는 인자로 받는다 — 원문을
 * 읽어 인계 메시지를 만드는 `detail`과, 실행이 붙었을 때 대화 탭으로 돌리는
 * `focusConversation`이다. 파일 놓기 영역과 대화 표시 범위 초기화는 탭·표시 범위를
 * 보는 판단이라 서랍에 그대로 두고, 여기서는 그 재료(`addFiles`·`resetContext`)만 낸다.
 *
 * 훅 안의 이름에는 `continuation` 머리말을 붙이지 않는다. 이 훅이 다루는 것이 이어가기
 * 실행 하나뿐이라 머리말이 무엇도 구분해 주지 못하면서, 돌려줄 때 `text: continuationText`
 * 처럼 40줄짜리 이름 바꾸기 표를 만들어 두 이름 중 어느 쪽이 정본인지 읽어 봐야 알게
 * 했다. 머리말은 부르는 쪽(`continuation.text`)이 붙인다.
 */
/**
 * 이어가기 첨부 초안 한 벌. 목록은 화면용 state와 전송 절차가 읽는 ref 두 벌로 들고 있다 —
 * 전송은 비동기 중간에도 최신 목록을 봐야 해 ref가 필요하고, 한쪽만 갱신하면 방금 담은
 * 파일이 빠진 채 올라가거나 지운 파일이 되살아난다.
 */
interface ContinuationAttachments {
  /** 화면이 그리는 목록. */
  drafts: ChatAttachmentDraft[];
  /** 전송 절차가 비동기 중간에 읽는 최신 목록. */
  current: () => ChatAttachmentDraft[];
  /** 목록을 통째로 갈아 끼운다. 올린 결과를 되돌려받는 전송 절차가 그대로 넘겨 쓴다. */
  replace: (next: ChatAttachmentDraft[]) => void;
  add: (files: File[]) => void;
  remove: (draft: ChatAttachmentDraft) => void;
  /** 대기열에서 되불러 온 첨부를 지금 목록 뒤에 잇는다. */
  append: (next: ChatAttachmentDraft[]) => void;
}

/**
 * 이어가기 첨부 초안을 맡는다. 이어가기 훅 본문에 두 벌(state·ref)과 그 둘을 함께 바꾸는
 * 손잡이, 담기·빼기가 섞여 있어 "지금 목록이 무엇인가"를 읽으려면 600줄을 훑어야 했다.
 * 두 벌을 함께 바꾸는 자리를 이 훅 안으로 가두고, 바깥에는 ref를 읽는 창구와 목록을 바꾸는
 * 손잡이만 내놓는다. 올린 첨부를 놓아주는 일까지 여기서 하므로 `connectionRef`를 받는다.
 */
function useContinuationAttachments(
  connectionRef: RefObject<ChatConnection | null>,
  onError: (message: string) => void,
): ContinuationAttachments {
  const [drafts, setDrafts] = useState<ChatAttachmentDraft[]>([]);
  const draftsRef = useRef<ChatAttachmentDraft[]>([]);
  const replace = useCallback((next: ChatAttachmentDraft[]) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  return {
    drafts,
    current: () => draftsRef.current,
    replace,
    add: (files) => {
      // 이 배너는 첨부 전용이 아니라 이어가기 오류와 함께 쓰므로, 거절 문구가 있을 때만 넣는다.
      replace(addAttachmentDrafts(draftsRef.current, files, (message) => {
        if (message) onError(message);
      }));
    },
    remove: (draft) => {
      replace(draftsRef.current.filter((item) => item.key !== draft.key));
      releaseAttachmentDraftUpload(draft, connectionRef.current?.info.chatId);
    },
    append: (next) => replace([...draftsRef.current, ...next]),
  };
}

/**
 * 자동 재연결이 화면에 써 넣는 자리 한 벌. 붙은 실행을 찾는 일과 그 결과를 화면에
 * 옮기는 일은 서로 다른 관심사라, 옮겨 쓰는 쪽만 이름을 붙여 넘긴다. 여기 없는 값은
 * 이 갈래가 건드리지 않는다는 뜻이다.
 */
interface ContinuationAttachSink {
  /** attach가 리플레이로 스트림을 다시 채우므로 진행 중 턴 표시도 함께 비운다. */
  activeTurnRef: RefObject<string | null>;
  markIdle: () => void;
  setTurns: Dispatch<SetStateAction<ChatTurn[]>>;
  setPhase: Dispatch<SetStateAction<ContinuationPhase>>;
  setSettings: Dispatch<SetStateAction<ContinuationSettings>>;
  setUnattended: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

/**
 * 이 세션에 이미 떠 있는 실행을 찾아 붙인다. 드로어를 열 때마다, 그리고 알림을 따라 열릴
 * 때마다 한 번씩 도는 갈래로, 이어보내기가 새 실행을 띄우는 갈래와는 반대 방향이다 —
 * 여기서는 연결을 만들지 않고 이미 있는 것만 넘겨받는다.
 *
 * 이어가기 한 벌 본문에 섞여 있던 것을 떼어 냈다. 본문은 입력·설정·전송을 다루는데 이
 * 갈래만 "누가 먼저 열어 두었는가"라는 다른 질문에 답하고, 끊긴 실행의 이벤트를 걸러
 * 내는 세대 규칙과 리플레이 순서를 지키는 주석이 모두 여기에만 걸린다. 쓰는 값을
 * `sink` 한 벌로 받아, 이 갈래가 화면의 무엇을 건드리는지 서명에서 그대로 보이게 한다.
 */
function useContinuationAutoAttach({
  session,
  attachChatId,
  attachRequestId,
  onAttachHandled,
  focusConversation,
  ownership,
  handleEvent,
  sink,
}: {
  session: SessionSummary;
  attachChatId: string | null;
  /** 같은 알림을 다시 눌렀을 때도 이 갈래를 한 번 더 돌리는 값. */
  attachRequestId: number;
  onAttachHandled: (opened: boolean) => void;
  focusConversation: () => void;
  ownership: ContinuationConnectionOwnership;
  handleEvent: (event: ChatEvent, generation: number) => void;
  sink: ContinuationAttachSink;
}): void {
  const { connectionRef, appliedStateGenerationRef, nextGeneration, adopt } = ownership;
  // sink의 손잡이는 모두 렌더가 바뀌어도 같은 참조다(useState의 setter·useCallback·ref).
  // 그래서 효과의 의존성은 떼어 내기 전과 같은 목록으로 남는다.
  const { activeTurnRef, markIdle, setTurns, setPhase, setSettings, setUnattended, setError } = sink;

  useEffect(() => {
    const connected = connectionRef.current;
    if (connected && (!attachChatId || connected.info.chatId === attachChatId)) {
      if (attachChatId) {
        focusConversation();
        onAttachHandled(true);
      }
      return undefined;
    }
    if (connected) {
      // 알림은 생성 당시 chatId를 들고 있다. 같은 공급자 세션이 이후 새 런타임으로
      // 이어졌다면 현재 세션 상세의 연결이 더 최신이므로 끊거나 옛 실행으로 되돌리지 않는다.
      focusConversation();
      setError(null);
      if (attachChatId) onAttachHandled(true);
      return undefined;
    }
    if (session.isSubagent) {
      if (attachChatId) onAttachHandled(false);
      return undefined;
    }

    let cancelled = false;
    const generation = nextGeneration();
    setError(null);
    setPhase("connecting");
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
      focusConversation();
      // attach는 백엔드가 과거 이벤트를 리플레이하므로 스트림을 리플레이 기준으로 다시 채운다.
      activeTurnRef.current = null;
      setTurns([]);
      return attachChat(chatId, (event) => handleEvent(event, generation));
    })()
      .then((connection) => {
        if (cancelled) {
          if (connection) void connection.detach();
          return;
        }
        if (!connection) {
          markIdle();
          return;
        }
        adopt(connection);
        setSettings(connectionContinuationSettings(connection.info));
        setUnattended(connection.info.unattended);
        // `connection.info`는 백엔드가 리플레이 맨 앞에서 보낸 **첫** state다. 리플레이
        // 끝에 붙는 현재 state를 이미 반영한 뒤라면 과거 상태이므로 덮어쓰지 않는다.
        // 덮어쓰면 응답 중인 세션이 '입력 대기'로 되돌아가 정지 대신 전송 버튼이 뜬다.
        if (appliedStateGenerationRef.current !== generation) {
          setPhase(connection.info.state);
        }
        if (attachChatId) onAttachHandled(true);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        markIdle();
        const label = attachChatId ? runtimeText("알림의 실행", "run from notification") : runtimeText("기존 CLI 실행", "existing CLI run");
        setError(runtimeText(`${label}에 다시 연결하지 못했습니다: ${errorText(cause)}`, `Failed to reconnect to ${label}: ${errorText(cause)}`));
        if (attachChatId) onAttachHandled(false);
      });
    return () => { cancelled = true; };
  }, [adopt, attachChatId, attachRequestId, focusConversation, handleEvent, markIdle, nextGeneration, onAttachHandled, session.id, session.isSubagent, session.source]);
}

function useSessionContinuation({
  session,
  sessions,
  detail,
  attachChatId,
  attachRequestId,
  onAttachHandled,
  onSessionCatalogChanged,
  focusConversation,
  confirm,
}: {
  session: SessionSummary;
  sessions: SessionSummary[];
  detail: SessionDetail | null;
  attachChatId: string | null;
  attachRequestId: number;
  onAttachHandled: (opened: boolean) => void;
  onSessionCatalogChanged: (source: ProviderId, id: string) => Promise<void>;
  /** 실행이 붙거나 알림을 따라 열렸을 때 대화 탭으로 돌린다. */
  focusConversation: () => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [source, setSource] = useState<ProviderId>(session.source);
  // 같은 공급자로도 새 세션에 인계할 수 있다. 컨텍스트가 찬 세션은 재개보다 넘기는 편이
  // 나은데, 그러자고 공급자까지 바꿀 이유는 없다. 공급자가 다르면 세션 ID를 공유할 수
  // 없어 인계가 유일한 길이므로, 그때는 이 선택과 무관하게 인계로 간다.
  const [handoff, setHandoff] = useState(false);
  // 이어가기 실행 설정 다섯 칸은 언제나 함께 읽히고 함께 갈린다(재연결이 알려준 값으로
  // 덮기, 공급자 교체 시 기본값으로 되돌리기, 변경 실패 시 이전 값으로 되돌리기). 칸마다
  // 상태를 따로 두면 그 세 갈래가 매번 다섯 줄로 늘어나므로 한 벌로 들고 다닌다.
  const [settings, setSettings] = useState<ContinuationSettings>(() => sessionContinuationSettings(session));
  const {
    mode,
    approvalMode,
    model,
    reasoningEffort,
    extraSettings,
  } = settings;
  const [phase, setPhase] = useState<ContinuationPhase>("idle");
  const { context, applyLive: applyLiveContext, clear: clearContext } = useContinuationContextSize();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [queue, setQueue] = useState<QueuedChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 붙은 실행이 반복 요청이 소유한 unattended 런타임인지. 이 런타임은 스케줄러가
  // 결과를 기다리고 있으므로, 화면이 임의로 멈추거나 갈아 끼우면 그 회차가 통째로
  // 사라진다. 진행 상태는 그대로 보여 주되 실행을 끊는 조작만 막는다.
  const [unattended, setUnattended] = useState(false);
  const ownership = useContinuationConnection(sessionKey(session.source, session.id));
  const {
    connectionRef,
    generationRef,
    appliedStateGenerationRef,
    attachedCwd,
    nextGeneration,
    take: takeConnection,
    adopt: adoptConnection,
    claimSessionSync,
  } = ownership;
  const attachmentDrafts = useContinuationAttachments(connectionRef, setError);
  const activeTurnRef = useRef<string | null>(null);
  /** 붙어 있는 실행이 없는 상태로 되돌린다. 대기열·원문처럼 갈래마다 다른 것은 각자 비운다. */
  const markIdle = useCallback(() => {
    setPhase("idle");
    setUnattended(false);
  }, []);
  /** 연결을 끝내 얻지 못했다. 붙은 실행이 없는 상태로 되돌리고 이유만 남긴다. */
  const fail = useCallback((cause: unknown) => {
    connectionRef.current = null;
    markIdle();
    setError(errorText(cause));
  }, [markIdle]);
  /**
   * 붙어 있는 실행을 끊고 이 화면에서 놓아준다. 공급자를 바꿀 때와 실행 설정을 바꿀 때가
   * 같은 순서(stop → 세대를 올리며 ref 비우기 → detach → 대기열 비우기)를 따로 적고
   * 있었는데, 한쪽에서 순서가 어긋나면 끊긴 실행의 이벤트가 새 연결 화면에 섞이거나 이미
   * 사라진 실행의 대기열이 화면에 남는다. 멈추지 못하면 **놓지 않고** 사유만 돌려준다 —
   * 살아 있는 실행을 놓아 버리면 화면이 그 실행을 다시 찾을 길이 없기 때문이고, 그다음에
   * 무슨 문구를 남길지는 자리마다 달라 부르는 쪽이 맡는다.
   */
  const stopAndRelease = async (connection: ChatConnection | null): Promise<{ cause: unknown } | null> => {
    if (connection) {
      try {
        await connection.stop();
      } catch (cause) {
        return { cause };
      }
    }
    takeConnection();
    if (connection) await detachStoppedConnection(connection);
    setQueue([]);
    return null;
  };
  const providerOptions = useProviderOptions(source);
  const recentModels = useMemo(
    () => recentModelsFor(sessions, source),
    [source, sessions],
  );
  const modelOptions = providerOptions?.models ?? [];
  const reasoningOptions = reasoningOptionsFor(providerOptions, model);
  const settingFields = useMemo(
    () => settingFieldsFor(providerOptions, source),
    [source, providerOptions],
  );

  // 세션 메타에 저장된 권한·승인 값이 최신 CLI 스키마에서 사라졌으면 안전한 값으로
  // 되돌린다. 이어가기는 새 실행이므로 지원하지 않는 값으로 시작하면 안 된다.
  useEffect(() => {
    setSettings((current) => {
      const next: ContinuationSettings = {
        ...current,
        mode: normalizeSettingValue(settingFields, "mode", current.mode) as ChatMode,
        approvalMode: normalizeSettingValue(settingFields, "approvalMode", current.approvalMode) as ChatApprovalMode,
        extraSettings: normalizeExtraSettings(settingFields, current.extraSettings),
      };
      return sameContinuationSettings(current, next) ? current : next;
    });
  }, [settingFields]);

  const handleEvent = useCallback((event: ChatEvent, generation: number) => {
    if (generation !== generationRef.current) return;
    applyChatEvent(event, {
      activeTurnRef: activeTurnRef,
      setTurns: setTurns,
      setQueue: setQueue,
      onState: (info) => {
        appliedStateGenerationRef.current = generation;
        setPhase(info.state);
        setUnattended(info.unattended);
        setSettings((current) => ({ ...current, extraSettings: info.settings ?? {} }));
        applyLiveContext(info.contextUsedTokens, info.contextWindowTokens);
        if (info.providerSessionId && claimSessionSync(info.source, info.providerSessionId)) {
          void onSessionCatalogChanged(info.source, info.providerSessionId);
        }
        if (info.state === "stopped" || info.state === "failed") {
          setQueue([]);
          setUnattended(false);
          const connection = connectionRef.current;
          connectionRef.current = null;
          if (connection) void connection.detach();
        }
      },
      onError: setError,
    });
  }, [applyLiveContext, claimSessionSync, onSessionCatalogChanged]);

  useEffect(() => () => {
    const connection = takeConnection();
    if (connection) void connection.detach();
  }, [takeConnection]);

  useContinuationAutoAttach({
    session,
    attachChatId,
    attachRequestId,
    onAttachHandled,
    focusConversation,
    ownership,
    handleEvent,
    sink: { activeTurnRef, markIdle, setTurns, setPhase, setSettings, setUnattended, setError },
  });

  const target = continuationTarget(session, attachedCwd);

  const detached = isDetachedPhase(phase);
  const responding = isRespondingPhase(phase);
  const busy = isBusyPhase(phase);
  /**
   * 이어가기 설정이 새 세션 인계를 가리키는지. 다른 공급자는 세션 ID를 공유할 수 없어
   * 선택과 무관하게 인계가 유일한 길이다.
   */
  const handoffSelected = source !== session.source || handoff;
  /**
   * 다음 전송이 원래 세션 재개가 아니라 새 세션 인계로 나갈지. 붙어 있는 실행이 있으면
   * 그 실행이 이어갈 대상이므로 인계는 다음 시작에만 해당한다.
   */
  const agentHandoffPending = detached && handoffSelected;

  const pendingApprovals = turns.flatMap((turn) => turn.entries).filter((entry): entry is Extract<ChatEntry, { type: "approval" }> => entry.type === "approval" && entry.interactive && !entry.resolved);
  const pendingPlanApproval = pendingApprovals.find((entry) => entry.kind === "plan") ?? null;

  /**
   * 이어보내기에 쓸 연결을 확보한다. 이미 붙어 있으면 그대로 쓰고, 없을 때만 새로 띄운다.
   * 다른 창이 같은 세션을 먼저 열어 두었으면 그 실행에 붙어 이어간다. 실패는 여기서
   * 문구로 닫고 `null`을 돌려주므로, 부르는 쪽은 성공한 연결만 다룬다.
   *
   * 함께 돌려주는 `startingAgentHandoff`는 이번 호출이 인계로 시작한 새 세션인지를 가리킨다.
   * 보낼 본문을 인계 메시지로 감쌀지가 여기서 갈리므로 전송 쪽까지 들고 간다.
   */
  const ensureConnection = async (
    cwd: string,
    planRestart?: { request: string; mode: ChatMode },
  ): Promise<{ connection: ChatConnection; startingAgentHandoff: boolean } | null> => {
    const existing = connectionRef.current;
    if (existing) return { connection: existing, startingAgentHandoff: false };

    const startingAgentHandoff = handoffSelected;
    setPhase("connecting");
    const generation = nextGeneration();
    try {
      const connection = await connectChat({
        source: source,
        cwd,
        model: model || null,
        reasoningEffort: reasoningEffort || null,
        mode: planRestart?.mode ?? mode,
        approvalMode: approvalMode,
        resumeSessionId: startingAgentHandoff ? null : session.id,
        handoffOrigin: startingAgentHandoff ? { source: session.source, id: session.id } : null,
        unattended: false,
        settings: extraSettings,
      }, (event) => handleEvent(event, generation));
      adoptConnection(connection);
      setPhase(connection.info.state);
      // 인계는 한 번의 동작이다. 새 세션이 떴으면 이후 메시지는 그 세션을 이어가야지,
      // 설정 변경으로 연결이 끊길 때마다 또 다른 세션을 만들어서는 안 된다.
      if (startingAgentHandoff) setHandoff(false);
      if (connection.info.providerSessionId) {
        // 이미 알린 세션이어도 다시 알린다. 새 실행이 붙었다는 것 자체가 색인이 아직
        // 모르는 변화라, state 이벤트 쪽과 달리 처음인지를 보지 않고 그대로 알린다.
        claimSessionSync(connection.info.source, connection.info.providerSessionId);
        void onSessionCatalogChanged(connection.info.source, connection.info.providerSessionId);
      }
      return { connection, startingAgentHandoff };
    } catch (cause) {
      if (cause instanceof ChatRejectedError
        && cause.code === "sessionBusy"
        && cause.existingChatId) {
        try {
          const connection = await attachChat(
            cause.existingChatId,
            (event) => handleEvent(event, generation),
          );
          adoptConnection(connection);
          setPhase(connection.info.state);
          setError(null);
          return { connection, startingAgentHandoff };
        } catch (attachCause) {
          fail(attachCause);
          return null;
        }
      }
      fail(cause);
      return null;
    }
  };

  /**
   * 이어가기 메시지를 보낸다. `deliverNow`면 응답 중에도 중단 없이 진행 중인 작업에 바로
   * 전달한다.
   *
   * `planRestart`는 사용자가 입력창에 쓴 메시지가 아니라, 계획 승인을 접고 새 권한 범위로
   * 다시 띄우면서 앱이 만들어 보내는 요청이다. 설정 상태는 이 호출을 만든 렌더의 값이라
   * 방금 바꾼 모드를 아직 모르므로, 다시 띄울 모드를 함께 받는다. 입력창의 초안과 첨부는
   * 그대로 둔다 — 사용자가 쓰던 메시지를 앱이 대신 보내거나 지워서는 안 된다.
   */
  const deliver = async (deliverNow: boolean, planRestart?: { request: string; mode: ChatMode }) => {
    const request = (planRestart?.request ?? text).trim();
    const drafts = planRestart ? [] : attachmentDrafts.current();
    if ((!request && drafts.length === 0) || phase === "connecting" || uploading) return;
    if (target.blocked !== null) {
      setError(target.blocked.detail);
      return;
    }
    setError(null);
    const established = await ensureConnection(target.cwd, planRestart);
    if (!established) return;
    const { connection, startingAgentHandoff } = established;
    setUploading(true);
    try {
      const outgoingText = startingAgentHandoff
        ? buildSessionHandoffMessage({
          source: session.source,
          sessionId: session.id,
          transcript: detail?.transcript ?? [],
          request,
        })
        : request;
      await sendWithAttachmentDrafts(connection, outgoingText, drafts, attachmentDrafts.replace, { steer: deliverNow });
      if (!planRestart) {
        setText("");
        attachmentDrafts.replace([]);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUploading(false);
    }
  };

  /**
   * 반복 요청이 소유한 런타임이면 실행을 끊는 조작을 막고 이유를 남긴다. 이 런타임은
   * 스케줄러가 결과를 기다리고 있어, 화면에서 멈추거나 갈아 끼우면 그 회차가 통째로
   * 사라진다.
   */
  const blockedByUnattendedRuntime = () => {
    if (!unattended) return false;
    setError(UNATTENDED_RUNTIME_LOCK_MESSAGE);
    return true;
  };

  const changeSource = async (nextSource: ProviderId) => {
    if (nextSource === source || busy) return;
    // 공급자를 바꾸려면 붙어 있는 실행을 stop()으로 끊어야 한다.
    if (blockedByUnattendedRuntime()) return;

    const failure = await stopAndRelease(connectionRef.current);
    if (failure) {
      setError(runtimeText(`기존 에이전트 연결을 종료하지 못했습니다: ${errorText(failure.cause)}`, `Failed to terminate existing agent connection: ${errorText(failure.cause)}`));
      return;
    }

    setSource(nextSource);
    setSettings(defaultContinuationSettings(nextSource));
    clearContext();
    setTurns([]);
    markIdle();
    setError(null);
  };

  const changeSettings = async (
    next: Partial<ContinuationSettings>,
    label: string,
    options?: { planAbandoned?: boolean },
  ): Promise<boolean> => {
    const previous = settings;
    const merged: ContinuationSettings = { ...previous, ...next };
    if (sameContinuationSettings(merged, previous) || phase === "connecting") return false;
    // 응답 중에 설정을 바꾸면 그 요청이 통째로 사라진다. 기다리던 계획 승인을 이미 취소로
    // 닫은 호출만 예외다 — 그 실행에는 지켜 줄 작업이 남아 있지 않다.
    if (!options?.planAbandoned && responding) return false;

    // 설정 변경은 기존 런타임을 stop()으로 끊고 새로 띄운다.
    if (blockedByUnattendedRuntime()) return false;
    const previousPhase = phase;
    const connection = connectionRef.current;
    setSettings(merged);
    setError(null);
    if (!connection) return true;

    setPhase("connecting");
    const failure = await stopAndRelease(connection);
    if (failure) {
      setSettings(previous);
      setPhase(previousPhase);
      setError(runtimeText(`${label} 변경하지 못했습니다: ${errorText(failure.cause)}`, `Failed to change ${label}: ${errorText(failure.cause)}`));
      return false;
    }

    markIdle();
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
  const changeMode = async (nextMode: ChatMode) => {
    const plan = pendingPlanApproval;
    if (!plan) {
      await changeSettings({ mode: nextMode }, runtimeText("요청 모드를", "request mode"));
      return;
    }
    // 계획 모드로 되돌리는 것은 "계획을 다시 세우라"는 뜻이고, 그건 승인 카드의 '계획 다시
    // 세우기'가 할 일이다. 계획을 넘겨받을 실행을 읽기 전용으로 띄우지는 않는다.
    if (nextMode === mode || nextMode === "plan") return;
    const accepted = await confirm({
      title: runtimeText("요청 모드를 바꿀까요?", "Change request mode?"),
      message: runtimeText(
        `같은 대화를 ${permissionModeLabel(nextMode)}로 다시 열어 이 계획을 넘깁니다.\n지금 실행은 계획을 승인하지 않고 접히므로 아직 아무것도 실행되지 않습니다.`,
        `Reopening the same conversation in ${permissionModeLabel(nextMode)} to pass this plan.\nThe current run is closed without approving the plan, so nothing has been executed yet.`,
      ),
      confirmLabel: runtimeText("이 계획으로 다시 시작", "Restart with this plan"),
    });
    if (!accepted) return;
    const request = planExecutionRequest(plan.detail ?? "", source);
    // 답을 기다리는 CLI를 그대로 접으면 제어 요청이 미결로 남는다. 승인 전에 취소로 닫는다.
    await decide(plan.id, "cancel");
    if (!await changeSettings({ mode: nextMode }, runtimeText("요청 모드를", "request mode"), { planAbandoned: true })) return;
    await deliver(false, { request, mode: nextMode });
  };

  const changeApprovalMode = (nextMode: ChatApprovalMode) =>
    changeSettings({ approvalMode: nextMode }, runtimeText("승인 처리를", "approval mode"));

  const changeModel = (nextModel: string) =>
    changeSettings({ model: nextModel }, runtimeText("응답 모델을", "response model"));

  const changeReasoningEffort = (nextEffort: ReasoningEffort | "") =>
    changeSettings({ reasoningEffort: nextEffort }, runtimeText("추론 수준을", "reasoning effort"));

  const changeExtraSettings = (nextSettings: Record<string, string>) =>
    changeSettings({ extraSettings: nextSettings }, runtimeText("추가 설정을", "extra settings"));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await deliver(false);
  };

  // 이어보내기 연결을 건드리는 조작은 모두 이전 오류를 비우고 실패만 문구로 남긴다.
  // busy 표시가 없는 것은 의도한 것 — 대기열 조작은 즉시 끝나고 화면을 잠글 이유가 없다.
  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const removeQueued = async (messageId: string) => {
    await runAction(async () => {
      await connectionRef.current?.removeQueued(messageId);
    });
  };

  const recallQueued = async (message: QueuedChatMessage) => {
    await runAction(async () => {
      await connectionRef.current?.removeQueued(message.id);
      setText((current) => current.trim() ? `${current}\n${message.text}` : message.text);
      attachmentDrafts.append(queuedAttachmentsToDrafts(message.attachments, connectionRef.current?.info.chatId ?? null));
    });
  };

  const decide = async (approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>, secret?: string, saveSecret?: boolean) => {
    await runAction(async () => {
      await connectionRef.current?.approve(approvalId, decision, answers, secret, saveSecret);
    });
  };

  const interrupt = async () => {
    await runAction(async () => {
      await connectionRef.current?.interrupt();
    });
  };

  /**
   * 공급자 앱으로 같은 대화를 넘기기 전에 붙어 있는 실행을 놓아 준다. 설정 변경과 달리
   * 멈추지 못해도 놓는다 — 넘겨받을 앱이 곧 같은 세션을 열므로, 여기 남은 연결은 어차피
   * 쓸 수 없다. detach가 실패하면 그대로 던져 부르는 쪽이 문구로 닫는다.
   */
  const releaseForProviderApp = async () => {
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (!connection) return;
    try { await connection.stop(); } catch { /* The provider process may already be gone. */ }
    await detachStoppedConnection(connection);
    setPhase("stopped");
    setQueue([]);
  };

  const historicalContextUsed = useMemo(() => historicalContextUsedTokens(detail), [detail]);
  const displayedUsedTokens = displayedContextUsedTokens(context, historicalContextUsed, detached);
  const largeContextWarning = useMemo(
    () => largeContextWarningText(context, historicalContextUsed, detached, agentHandoffPending),
    [agentHandoffPending, context, detached, historicalContextUsed],
  );

  return {
    connectionRef,
    attachedCwd,
    target,
    text,
    setText,
    attachments: attachmentDrafts.drafts,
    uploading,
    source,
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
    turns,
    queue,
    error,
    setError,
    busy,
    detached,
    handoffSelected,
    agentHandoffPending,
    setHandoff,
    pendingApprovals,
    pendingPlanApproval,
    contextWindowTokens: context.window,
    displayedContextUsedTokens: displayedUsedTokens,
    largeContextWarning,
    resetContext: clearContext,
    addFiles: attachmentDrafts.add,
    removeAttachment: attachmentDrafts.remove,
    changeSource,
    changeMode,
    changeApprovalMode,
    changeModel,
    changeReasoningEffort,
    changeExtraSettings,
    submit,
    deliver,
    interrupt,
    removeQueued,
    recallQueued,
    decide,
    releaseForProviderApp,
  };
}

/**
 * 이어가기 한 벌. 드로어가 이 한 벌을 머리글·설정 판·작성기 세 구역에 나눠 주므로, 낱개로
 * 스무 개씩 늘어놓는 대신 이름을 붙여 들고 다닌다.
 */
type SessionContinuation = ReturnType<typeof useSessionContinuation>;

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
  const { text } = useI18n();
  const drawerTabs = sessionDrawerTabs(text);
  const { confirm, confirmDialog } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const metaEditor = useOptimisticSessionMeta(session, onMetaChanged, setError);
  const { meta, patchMeta } = metaEditor;
  const settingsPanel = useSessionSettingsPanel(session.source);
  const [activeTab, setActiveTab] = useState<SessionDrawerTab>("conversation");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const drawerBodyRef = useRef<HTMLDivElement>(null);
  const focusConversation = useCallback(() => setActiveTab("conversation"), []);
  const loadLinkedFile = useCallback(
    (href: string) => getSessionLinkedFile(session.source, session.id, href),
    [session.id, session.source],
  );
  const downloadLinkedFile = useCallback(
    (href: string) => downloadSessionLinkedFile(session.source, session.id, href),
    [session.id, session.source],
  );
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);

  // 대화 원문과 이전 구간 페이징은 채팅 화면과 같은 훅이 맡는다. 여기서는 드로어 본문이
  // 스크롤을 담당하므로 그 요소를 넘겨 이전 구간을 붙인 뒤 위치가 유지되게 한다.
  const transcript = useSessionTranscript({
    source: session.source,
    sessionId: session.id,
    limit: transcriptLimit,
    scrollContainerRef: drawerBodyRef,
  });
  const { detail, error: transcriptError, refresh: refreshSessionTranscript } = transcript;

  // 이어가기 실행 한 벌. 원문을 읽어 인계 메시지를 만들어야 해 `detail`이 선다음이다.
  const continuation = useSessionContinuation({
    session,
    sessions,
    detail,
    attachChatId,
    attachRequestId,
    onAttachHandled,
    onSessionCatalogChanged,
    focusConversation,
    confirm,
  });

  // 대화 안에서 찾기. 드로어 본문이 스크롤을 맡으므로 그 요소를 훑고, 막대는 스크롤 조작
  // 묶음과 같은 겹(bodyOverlay)에 떠 있다 — 흐름에 끼우면 열 때마다 본문이 아래로 밀린다. 원문은 최신
  // 쪽부터 창 단위로 올라오므로, 아직 올라오지 않은 구간이 남아 있으면 막대가 그 사실을
  // 함께 적는다(ChatFindBar).
  const { findBar } = useChatFind({
    containerRef: drawerBodyRef,
    enabled: activeTab !== "terminal",
    resetKey: sessionKey(session.source, session.id),
    priority: FIND_PRIORITY.sessionDrawer,
  });

  // 읽던 자리. 이 화면은 뒤(최신)에서부터 읽으므로, 찾는 자리가 아직 올라오지 않았으면
  // '이전 대화 더보기'와 같은 조회로 앞 구간을 붙여 가며 다시 찾는다.
  const { controls: readingControls, captureReadingPoint } = useReadingBookmarks({
    containerRef: drawerBodyRef,
    source: session.source,
    sessionId: session.id,
    resetKey: sessionKey(session.source, session.id),
    onMetaChanged,
    onExpandRange: useCallback(async () => {
      if (transcript.earlierLoadCount <= 0) return false;
      await transcript.loadEarlier();
      return true;
    }, [transcript]),
  });

  const { pauseFollowingLatestMessages, resumeFollowingLatestMessages } = useSessionDrawerScroll({
    bodyRef: drawerBodyRef,
    sessionId: session.id,
    sessionSource: session.source,
    transcriptLimit,
    messageDisplayMode,
    activeTab,
    detail,
    continuationTurns: continuation.turns,
    onBeforeJump: captureReadingPoint,
  });

  // 재연결 대상 실행이 백엔드 교체로 사라졌다면 원문뿐 아니라 Core가 별도 보관한
  // 중단 기록도 즉시 다시 읽어, 사라진 응답의 이유를 빈 화면 대신 남긴다.
  useEffect(() => {
    if (continuation.error === BACKEND_RESTARTED_MESSAGE) refreshSessionTranscript();
  }, [continuation.error, refreshSessionTranscript]);

  const resetContinuationContext = continuation.resetContext;
  useEffect(() => {
    setError(null);
    resetContinuationContext();
  }, [resetContinuationContext, session.source, session.id, transcriptLimit]);

  // 세션 상세 서랍 전체(대화 내역 + 이어가기 작성창)가 파일을 놓는 자리다.
  // 받지 않는 세 경우: 이어갈 수 없는 세션(작성창을 막는 조건과 같다), 작성창이 아예
  // 없는 탭(작업 로그·터미널 — 담아도 보여 줄 자리가 없어 조용히 사라진다), 그리고 앞
  // 첨부를 올리는 중(전송 절차가 목록을 스냅샷으로 덮어써 새로 놓은 파일이 지워진다).
  const continuationDropZone = useFileDropZone(
    continuation.addFiles,
    continuation.target.blocked !== null || activeTab !== "conversation" || continuation.uploading,
    continuation.setError,
  );

  return (
    <>
    <Drawer
      variant={popout ? "panel" : "overlay"}
      title={<>
        <SourceBadge source={session.source} />
        <button
          className={`session-favorite-toggle${meta.favorite ? " active" : ""}`}
          type="button"
          aria-label={meta.favorite ? text("즐겨찾기 해제", "Remove from favorites") : text("즐겨찾기 추가", "Add to favorites")}
          aria-pressed={meta.favorite}
          title={meta.favorite ? text("즐겨찾기 해제", "Remove from favorites") : text("즐겨찾기 추가", "Add to favorites")}
          onClick={() => patchMeta({ favorite: !meta.favorite })}
        >
          <Star size={16} fill={meta.favorite ? "currentColor" : "none"} aria-hidden="true" />
        </button>
        <span data-user-content>{meta.customTitle ?? session.sourceTitle ?? session.title}</span>
      </>}
      actions={<SessionDrawerHeaderActions
        session={session}
        popout={popout}
        continuationBusy={continuation.busy}
        settingsPanel={settingsPanel}
        onReleaseForProviderApp={continuation.releaseForProviderApp}
        onError={setError}
      />}
      headerContent={<div className="session-drawer-header-content">
        {settingsPanel.expanded && <SessionDrawerSettingsPanel
          providers={providers}
          session={session}
          sessions={sessions}
          folders={folders}
          editor={metaEditor}
          detail={detail}
          accounts={settingsPanel.accounts}
          panelRef={settingsPanel.panelRef}
          transcriptLimit={transcriptLimit}
          continuation={continuation}
          onTranscriptLimitChange={onTranscriptLimitChange}
          onOpenRelatedSession={onOpenRelatedSession}
        />}
        <div className="drawer-tabs" role="tablist" aria-label={text("세션 상세 보기", "Session details")}>
          {drawerTabs.map(({ id, label, Icon }) => (
            <SessionDetailTab selected={activeTab === id} onSelect={() => setActiveTab(id)} key={id}>
              <Icon size={13} aria-hidden="true" /><span>{label}</span>
            </SessionDetailTab>
          ))}
        </div>
      </div>}
      onClose={onClose}
      dropZone={continuationDropZone}
      bodyRef={drawerBodyRef}
      bodyOverlay={<>
        {findBar}
        {activeTab === "conversation" && <ChatScrollControls
          targetRef={drawerBodyRef}
          leading={readingControls}
          onScrollAwayFromLatest={pauseFollowingLatestMessages}
          onScrollToLatest={resumeFollowingLatestMessages}
        />}
      </>}
      footer={activeTab === "conversation" ? <><ChatApprovalDock title={text("권한 승인 대기", "Waiting for approval")} hint={text("선택할 때까지 에이전트 작업이 일시 정지됩니다.", "Agent work is paused until a choice is made.")} prompts={continuation.pendingApprovals} onDecision={continuation.decide} /><SessionContinuationComposer continuation={continuation} /></> : undefined}
    >
      {activeTab === "terminal" ? (
        <TerminalPanel session={session} />
      ) : <>
      {(error ?? transcriptError) && <ErrorBanner message={error ?? transcriptError ?? ""} />}
      <SessionDrawerTranscriptSection
        activeTab={activeTab}
        transcript={transcript}
        transcriptLimit={transcriptLimit}
        continuationTurns={continuation.turns}
        activityFilter={activityFilter}
        onActivityFilterChange={setActivityFilter}
        onOpenLocalLink={linkedFilePreview.open}
        scrollContainerRef={drawerBodyRef}
      />
      {activeTab === "conversation" && continuation.turns.length > 0 && (
        <section className="session-continuation-stream" aria-live="polite">
          <div className="section-title"><h3>{text("이어지는 대화", "Continued conversation")}</h3><span>{text("현재 연결", "Current connection")}</span></div>
          {continuation.turns.map((turn) => <ChatConversationTurn
            turn={turn}
            chatId={continuation.connectionRef.current?.info.chatId ?? attachChatId}
            className="session-continuation-turn"
            onDecision={continuation.decide}
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

/**
 * 드로어 머리글 오른쪽 동작 줄. `Codex에서 열기`는 붙어 있는 실행을 먼저 놓아준 뒤에야
 * 앱을 여는 두 단계 조작이라 그동안 버튼을 잠글 상태가 필요한데, 그 상태는 이 줄 밖에서
 * 쓰이지 않으므로 드로어 본문이 아니라 여기서 든다. 실패 문구만 드로어로 올려 보낸다.
 */
function SessionDrawerHeaderActions({ session, popout, continuationBusy, settingsPanel, onReleaseForProviderApp, onError }: {
  session: SessionSummary;
  popout: boolean;
  continuationBusy: boolean;
  settingsPanel: SessionSettingsPanel;
  onReleaseForProviderApp: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { text } = useI18n();
  const [openingProviderApp, setOpeningProviderApp] = useState(false);

  const openInCodex = async () => {
    if (session.source !== "codex" || openingProviderApp) return;
    setOpeningProviderApp(true);
    onError(null);
    try {
      await onReleaseForProviderApp();
      await openProviderSessionApp(session.source, session.id);
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setOpeningProviderApp(false);
    }
  };

  return (
    <>
      {!popout && <button
        className="button compact"
        type="button"
        onClick={() => { void openPopoutWindow({ kind: "session", source: session.source, sessionId: session.id }).catch((cause: unknown) => onError(errorText(cause))); }}
        title={text("이 세션을 별도 창으로 엽니다", "Open this session in a separate window")}
      ><AppWindow size={13} /><span>{text("새 창으로 열기", "Open in new window")}</span></button>}
      {hasTauriRuntime() && session.source === "codex" && <button
        className="button compact session-provider-open"
        type="button"
        disabled={openingProviderApp || continuationBusy}
        onClick={() => void openInCodex()}
        title={text("이 연결을 종료하고 같은 대화를 Codex 앱에서 엽니다", "Close this connection and open the same conversation in Codex app")}
      ><ExternalLink size={13} /><span>{openingProviderApp ? text("여는 중…", "Opening…") : text("Codex에서 열기", "Open in Codex")}</span></button>}
      <button
        className={`button compact session-settings-toggle${settingsPanel.expanded ? " active" : ""}`}
        type="button"
        ref={settingsPanel.toggleRef}
        aria-expanded={settingsPanel.expanded}
        aria-controls="session-drawer-settings"
        onClick={settingsPanel.toggle}
        title={settingsPanel.expanded ? text("세션 설정 접기", "Collapse session settings") : text("세션 설정 펼치기", "Expand session settings")}
      >
        <SlidersHorizontal size={13} />
        <span>{text("세션 설정", "Session settings")}</span>
        <ChevronDown className="session-settings-chevron" size={13} aria-hidden="true" />
      </button>
    </>
  );
}

/**
 * 머리글에서 펼쳐지는 세션 설정 판. 구역 일곱 개가 드로어 본문 한가운데 그대로 늘어서
 * 있어 본문을 읽을 때 대화·작성기와 설정이 뒤섞였다. 판이 필요로 하는 값만 받는 한 벌로
 * 묶고, 이어가기로 바꿔 갈 수 있는 공급자를 추리는 일도 그 목록을 쓰는 이 판에서 한다.
 */
function SessionDrawerSettingsPanel({
  providers,
  session,
  sessions,
  folders,
  editor,
  detail,
  accounts,
  panelRef,
  transcriptLimit,
  continuation,
  onTranscriptLimitChange,
  onOpenRelatedSession,
}: {
  providers: ProviderStatus[];
  session: SessionSummary;
  sessions: SessionSummary[];
  folders: SessionFolder[];
  editor: SessionMetaEditor;
  detail: SessionDetail | null;
  accounts: ProviderAccountView[] | null;
  panelRef: RefObject<HTMLDivElement | null>;
  transcriptLimit: SessionTranscriptLimit;
  continuation: SessionContinuation;
  onTranscriptLimitChange: (limit: SessionTranscriptLimit) => void;
  onOpenRelatedSession: (session: SessionSummary) => void;
}) {
  // 아직 찾지 못한 CLI로는 이어갈 수 없다. 지금 세션의 공급자는 그 판정과 무관하게 남긴다
  // — 이미 그 공급자로 만들어진 세션이라 목록에서 사라지면 고른 값이 비어 보인다.
  const selectableProviders = useMemo(
    () => providers.filter((provider) => provider.cli.detected || provider.provider === session.source),
    [providers, session.source],
  );

  return (
    <div className="session-drawer-settings" id="session-drawer-settings" ref={panelRef}>
      <SessionManageSection
        editor={editor}
        transcriptLimit={transcriptLimit}
        transcriptItemCount={detail ? detail.transcript.length : null}
        onTranscriptLimitChange={onTranscriptLimitChange}
      />

      <SessionFolderPickerSection folders={folders} editor={editor} />

      <SessionContinuationAgentSection
        originSource={session.source}
        providers={selectableProviders}
        continuationSource={continuation.source}
        continuationBusy={continuation.busy}
        continuationDetached={continuation.detached}
        handoffSelected={continuation.handoffSelected}
        handoffPending={continuation.agentHandoffPending}
        onChangeSource={(next) => void continuation.changeSource(next)}
        onChangeHandoff={continuation.setHandoff}
      />

      <SessionHandoffLinksSection meta={editor.meta} sessions={sessions} onOpen={onOpenRelatedSession} />

      <SessionAccountPinSection
        accounts={accounts}
        editor={editor}
        handoffSelected={continuation.handoffSelected}
      />

      <SessionMetadataSection editor={editor} sourceTitle={session.sourceTitle} />

      <SessionDetailFacts session={session} meta={editor.meta} detail={detail} attachedCwd={continuation.attachedCwd} />
    </div>
  );
}

/**
 * 드로어 본문 위쪽의 파일 원문 구역. '이어지는 대화'는 attach 시 백엔드가 리플레이한 과거
 * 이벤트까지 보여 주고 그 구간은 파일 원문에도 이미 남아 있으므로, 라이브가 담당하는
 * 시점부터는 여기서 잘라내 같은 턴이 두 번 보이지 않게 한다. 그 자르기와, 잘라낸 결과가
 * 비어 머리말만 남을 때 구역을 통째로 숨기는 판정은 이 구역 안에서만 쓰이므로 여기 둔다.
 * 표시 필터 상태는 드로어가 들고 있다 — 터미널 탭으로 갔다 와도 고른 값이 유지되어야 한다.
 */
function SessionDrawerTranscriptSection({
  activeTab,
  transcript,
  transcriptLimit,
  continuationTurns,
  activityFilter,
  onActivityFilterChange,
  onOpenLocalLink,
  scrollContainerRef,
}: {
  activeTab: SessionTranscriptTab;
  transcript: SessionTranscriptState;
  transcriptLimit: SessionTranscriptLimit;
  continuationTurns: ChatTurn[];
  activityFilter: ActivityFilter;
  onActivityFilterChange: (filter: ActivityFilter) => void;
  onOpenLocalLink: (href: string) => void;
  scrollContainerRef: RefObject<HTMLElement | null>;
}) {
  const { text } = useI18n();
  const { detail, error, loadingEarlier, earlierError, earlierLoadCount, loadEarlier } = transcript;
  const liveStreamBoundary = useMemo(() => liveStreamBoundaryMs(continuationTurns), [continuationTurns]);
  const liveStreamVisible = activeTab === "conversation" && continuationTurns.length > 0;
  const visibleTranscript = useMemo(() => {
    const items = detail?.transcript ?? [];
    return liveStreamVisible ? transcriptBeforeLiveStream(items, liveStreamBoundary) : items;
  }, [detail, liveStreamBoundary, liveStreamVisible]);
  // 파일 쪽에 남는 항목도, 더 불러올 이전 구간도 없으면 빈 '대화 내역' 머리말만 남는다.
  if (liveStreamVisible
    && Boolean(detail)
    && !detail?.unavailableReason
    && visibleTranscript.length === 0
    && earlierLoadCount === 0) return null;

  return (
    <section className={`transcript-section transcript-section-${activeTab}`}>
      <div className="section-title">
        <h3>{activeTab === "activity" ? text("작업 로그", "Activity log") : text("대화 내역", "Conversation history")}</h3>
        <div className="section-title-actions">
          <span>
            {detail ? text(`${visibleTranscript.length.toLocaleString()}개 항목`, `${visibleTranscript.length.toLocaleString()} items`) : ""}
            {detail?.truncated ? text(" · 이전 항목 생략", " · Earlier items omitted") : ""}
            {detail && detail.skippedLines > 0 ? text(` · 읽지 못한 줄 ${detail.skippedLines.toLocaleString()}개`, ` · ${detail.skippedLines.toLocaleString()} unreadable lines`) : ""}
          </span>
          {activeTab === "activity" ? <ActivityFilterSelect value={activityFilter} onChange={onActivityFilterChange} /> : null}
        </div>
      </div>
      {!detail && !error ? (
        <LoadingState label={text("대화 원문을 읽고 있습니다", "Reading conversation source…")} />
      ) : detail?.unavailableReason ? (
        <EmptyState title={text("본문을 열 수 없습니다", "Cannot open transcript")} detail={detail.unavailableReason} />
      ) : detail && visibleTranscript.length === 0 && earlierLoadCount === 0 ? (
        <EmptyState title={text("표시할 대화가 없습니다", "No conversation to display")} />
      ) : (
        <>
          <TranscriptLoadEarlier
            count={earlierLoadCount}
            loading={loadingEarlier}
            error={earlierError}
            onLoad={() => void loadEarlier()}
          />
          <TranscriptTurns items={visibleTranscript} mode={activeTab === "activity" ? "activity" : "conversation"} activityFilter={activityFilter} source={detail?.session.source ?? null} sessionId={detail?.session.id ?? null} onOpenLocalLink={onOpenLocalLink} scrollContainerRef={scrollContainerRef} windowed={transcriptLimit === "all"} />
        </>
      )}
    </section>
  );
}

/** 세션 상세 탭마다 같은 선택 상태와 접근성 속성을 한 벌로 유지한다. */
function SessionDetailTab({ selected, onSelect, children }: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={selected ? "active" : ""}
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

/**
 * 세션 서랍 상세 구역의 껍데기. 다섯 구역이 저마다 `detail-card` 클래스와 제목 `h4`를
 * 적고 있어, 구역을 하나 더 만들 때 어디까지가 껍데기 몫이고 어디부터가 그 구역 몫인지
 * 다른 구역을 보고 베껴야 했다. 껍데기는 여기 한 벌만 두고, 구역은 제 이름과 제목만 준다.
 */
function SessionDetailCard({ name, title, children }: {
  /** `detail-card` 뒤에 붙는 이 구역만의 클래스. */
  name: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`detail-card ${name}`}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/**
 * 이름표 하나와 칸 하나가 나란히 서는 줄. 상세 구역마다 같은 `form-row` 껍데기를 손으로
 * 적고 있었는데, 이름표가 짚는 `htmlFor`와 칸의 `id`가 한 줄 안에 두 번 나오는 모양이라
 * 베껴 쓰다 한쪽만 고치면 이름표가 엉뚱한 칸을 짚어도 화면은 그대로 그려진다.
 */
function SessionDetailFormRow({ label, htmlFor, children }: {
  label: ReactNode;
  /** 이름표가 짚을 칸의 id. 이름표가 칸을 품는 줄(체크상자)은 비워 둔다. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="form-row">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

/**
 * 세션 설정 맨 위의 관리 줄. 즐겨찾기·보관 토글과 대화 표시 범위는 모두 이 세션 하나를
 * 두고 즉시 반영되는 조작이라 드로어 본문에서 이 줄만 떼어 둔다.
 */
function SessionManageSection({ editor: { meta, patchMeta }, transcriptLimit, transcriptItemCount, onTranscriptLimitChange }: {
  editor: SessionMetaEditor;
  transcriptLimit: SessionTranscriptLimit;
  transcriptItemCount: number | null;
  onTranscriptLimitChange: (limit: SessionTranscriptLimit) => void;
}) {
  const { text } = useI18n();
  return (
    <section className="session-settings-toolbar" aria-label={text("세션 관리", "Manage session")}>
      <div className="detail-actions">
        <button className={meta.favorite ? "button primary" : "button"} type="button" onClick={() => void patchMeta({ favorite: !meta.favorite })}>
          <Star size={13} fill={meta.favorite ? "currentColor" : "none"} aria-hidden="true" /> {text("즐겨찾기", "Favorites")}
        </button>
        <button className="button danger-subtle" type="button" onClick={() => void patchMeta({ hidden: !meta.hidden })}>
          {meta.hidden ? text("보관 해제", "Unarchive") : text("보관", "Archive")}
        </button>
      </div>
      <TranscriptLimitSelect
        label={text("세션 대화 표시 범위", "Session transcript display range")}
        value={transcriptLimit}
        itemCount={transcriptItemCount}
        onChange={onTranscriptLimitChange}
      />
    </section>
  );
}

/** 이 세션이 속한 폴더를 켜고 끄는 알약 줄. 상위 폴더가 있으면 경로를 앞에 붙여 같은 이름을 가른다. */
function SessionFolderPickerSection({ folders, editor: { meta, saving, patchMeta } }: {
  folders: SessionFolder[];
  editor: SessionMetaEditor;
}) {
  const { text } = useI18n();
  return (
    <section className="session-folder-picker">
      <span>{text("폴더", "Folders")}</span>
      <div>
        {folders.length === 0 ? <small>{text("등록된 폴더가 없습니다.", "No registered folders.")}</small> : folders.map((folder) => {
          const assigned = meta.folderIds.includes(folder.id);
          return <button
            className={assigned ? "assigned" : ""}
            style={{ "--folder-color": folder.color } as CSSProperties}
            type="button"
            disabled={saving}
            key={folder.id}
            title={folderPathLabel(folders, folder.id)}
            onClick={() => void patchMeta({ folderIds: nextSessionFolderIds(meta.folderIds, folder.id, "toggle") })}
          >
            <i />
            {folder.parentId && <span className="folder-pill-path">{folderPathLabel(folders, folder.parentId)} /</span>}
            {folder.name}{assigned && <Check size={11} />}
          </button>;
        })}
      </div>
    </section>
  );
}

/**
 * 다음 전송을 어느 에이전트로 보낼지 고르는 칸. 공급자 선택과 인계 여부는 같은 결정의
 * 두 면이라(공급자가 다르면 인계 말고는 길이 없다) 한 칸에 묶여 있고, 맨 아래 안내문이
 * 그 조합이 실제로 무엇을 하는지 말한다.
 */
function SessionContinuationAgentSection({
  originSource,
  providers,
  continuationSource,
  continuationBusy,
  continuationDetached,
  handoffSelected,
  handoffPending,
  onChangeSource,
  onChangeHandoff,
}: {
  originSource: ProviderId;
  providers: ProviderStatus[];
  continuationSource: ProviderId;
  continuationBusy: boolean;
  continuationDetached: boolean;
  handoffSelected: boolean;
  handoffPending: boolean;
  onChangeSource: (next: ProviderId) => void;
  onChangeHandoff: (handoff: boolean) => void;
}) {
  const { text } = useI18n();
  return (
    <SessionDetailCard name="session-agent-handoff" title={text("이어갈 에이전트", "Continuation agent")}>
      <SessionDetailFormRow label={text("에이전트", "Agent")} htmlFor="session-continuation-agent">
        <select
          id="session-continuation-agent"
          value={continuationSource}
          disabled={continuationBusy}
          onChange={(event) => onChangeSource(event.target.value as ProviderId)}
        >
          {providers.map((provider) => <option
            key={provider.provider}
            value={provider.provider}
            disabled={!provider.cli.detected}
          >
            {provider.displayName}{provider.provider === originSource ? text(" · 원본", " · Original") : ""}{!provider.cli.detected ? text(" · CLI 미연결", " · CLI disconnected") : ""}
          </option>)}
        </select>
      </SessionDetailFormRow>
      <SessionDetailFormRow label={text("인계", "Handoff")}>
        <label className="check-filter">
          <input
            type="checkbox"
            checked={handoffSelected}
            // 다른 공급자는 세션 ID를 공유할 수 없어 인계 말고는 길이 없고, 실행이
            // 붙어 있는 동안에는 다음 전송이 그 실행으로 가므로 고를 것이 없다.
            disabled={continuationSource !== originSource || !continuationDetached}
            onChange={(event) => onChangeHandoff(event.target.checked)}
          />
          {text("새 세션으로 인계", "Hand off to new session")}
        </label>
      </SessionDetailFormRow>
      <small>{handoffPending
        ? text(`${sourceName(continuationSource)}의 새 세션을 만들고 최근 사용자·에이전트 대화를 인계합니다. 원본 세션은 변경하지 않습니다.`, `Creates a new session in ${sourceName(continuationSource)} and hands off recent user/agent conversation. Original session is not modified.`)
        : continuationDetached
          ? text("원래 에이전트의 같은 세션을 이어갑니다.", "Continues the same session with the original agent.")
          : text("붙어 있는 실행에 이어서 전달합니다.", "Delivers directly to the attached run.")}</small>
    </SessionDetailCard>
  );
}

/**
 * 표시 제목·메모 편집 칸. 저장을 누르기 전까지 초안은 화면 밖으로 나가지 않으므로 그
 * 두 상태도 여기서 들고 있는다. 드로어가 세션마다 새로 마운트되어(`key`가 세션 ID다)
 * 초안은 세션이 바뀔 때 함께 버려진다.
 */
function SessionMetadataSection({ editor: { meta, saving, patchMeta }, sourceTitle }: {
  editor: SessionMetaEditor;
  sourceTitle: string | null;
}) {
  const { text } = useI18n();
  const [title, setTitle] = useState(meta.customTitle ?? "");
  const [note, setNote] = useState(meta.note ?? "");
  return (
    <SessionDetailCard name="session-metadata-settings" title={text("메타데이터 설정", "Metadata settings")}>
      <SessionDetailFormRow label={text("표시 제목", "Display title")} htmlFor="session-title"><input id="session-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={sourceTitle ?? text("제목 입력", "Enter title")} /></SessionDetailFormRow>
      <SessionDetailFormRow label={text("메모", "Memo")} htmlFor="session-note"><textarea id="session-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder={text("이 세션에 대한 메모", "Memo for this session")} rows={3} /></SessionDetailFormRow>
      <div className="form-actions"><button className="button primary" type="button" disabled={saving} onClick={() => void patchMeta({ customTitle: title || null, note: note || null })}>{saving ? text("저장 중…", "Saving…") : text("메타데이터 저장", "Save metadata")}</button></div>
    </SessionDetailCard>
  );
}

/**
 * 인계 기록 구역. 어떤 세션과 이어졌는지 푸는 일까지 여기서 한다 — 서랍 본문은 이
 * 구역이 스스로 비어 있는지도 판단하므로 조건도 넘기지 않는다.
 */
function SessionHandoffLinksSection({ meta, sessions, onOpen }: {
  meta: SessionMeta;
  sessions: SessionSummary[];
  onOpen: (session: SessionSummary) => void;
}) {
  const { text } = useI18n();
  const links = useMemo(
    () => resolveSessionHandoffLinks(meta, sessions),
    [meta.handoffOrigin, meta.handoffTargets, sessions],
  );
  if (links.length === 0) return null;

  return (
    <SessionDetailCard name="session-handoff-links" title={text("에이전트 인계 기록", "Agent handoff history")}>
      <div>
        {links.map((item) => <button
          className="button"
          type="button"
          key={`${item.kind}:${sessionKey(item.link.source, item.link.id)}`}
          disabled={!item.session}
          title={item.session ? text("연결된 세션 열기", "Open connected session") : text("아직 세션 목록에서 찾지 못했습니다", "Not yet found in session list")}
          onClick={() => { if (item.session) onOpen(item.session); }}
        >
          <SourceBadge source={item.link.source} />
          <span>{item.kind === "origin" ? text("원본", "Original") : text("인계 대상", "Handoff target")} · {item.session?.meta.customTitle ?? item.session?.sourceTitle ?? item.session?.title ?? item.link.id}</span>
        </button>)}
      </div>
    </SessionDetailCard>
  );
}

/**
 * 실행 계정 고정 구역. 계정 목록을 문구로 푸는 일과 한도 소진 경고 계산이 이 구역
 * 밖에서는 쓰이지 않으므로 함께 둔다. 목록을 아직 못 받았거나 비어 있으면 그리지 않는다.
 */
function SessionAccountPinSection({ accounts, editor: { meta, saving, patchMeta }, handoffSelected }: {
  accounts: ProviderAccountView[] | null;
  editor: SessionMetaEditor;
  handoffSelected: boolean;
}) {
  const { text } = useI18n();
  /**
   * 고정된 계정의 한도가 모두 찼다면 초기화 시각(모르면 0). 고정 세션은 한도
   * 자동전환 대상이 아니라 고정을 바꾸기 전까지 실행이 계속 거부되므로, 실패를
   * 겪기 전에 고정하는 자리에서 알린다.
   */
  const exhaustedResetAt = useMemo(
    () => pinnedAccountExhaustedResetAt(accounts, meta.pinnedAccountId, Date.now()),
    [meta.pinnedAccountId, accounts],
  );
  if (accounts === null || accounts.length === 0) return null;

  const accountLabel = (accountId: string) => {
    const account = accounts.find((candidate) => candidate.id === accountId);
    return account ? `${account.displayName} (${account.email})` : accountId;
  };

  return (
    <SessionDetailCard name="session-account-pin" title={handoffSelected ? text("원본 세션 실행 계정", "Original session execution account") : text("실행 계정", "Execution account")}>
      <SessionDetailFormRow label={text("고정", "Pin")} htmlFor="session-account-pin">
        <select
          id="session-account-pin"
          value={meta.pinnedAccountId ?? ""}
          disabled={saving}
          onChange={(event) => void patchMeta({ pinnedAccountId: event.target.value || null })}
        >
          <option value="">{text("고정 없음 — 이어가기 설정에 따름", "No pin — follows continuation settings")}</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>
            {account.displayName} ({account.email}){account.isActive ? text(" · 활성", " · Active") : ""}
          </option>)}
        </select>
      </SessionDetailFormRow>
      <small>
        {text("고정하면 이어가기 설정과 무관하게 이 계정으로 실행하고, 한도 자동전환도 이 세션을 다른 계정으로 옮기지 않습니다.", "Pinning executes with this account regardless of continuation settings, and auto-switch will not move this session to another account.")}
        {meta.boundAccountId && text(` 마지막 실행 계정: ${accountLabel(meta.boundAccountId)}.`, ` Last execution account: ${accountLabel(meta.boundAccountId)}.`)}
      </small>
      {exhaustedResetAt !== null && <small className="session-account-pin-warning" role="alert">
        {exhaustedResetAt > 0
          ? text(
              `고정된 계정의 사용량 한도가 모두 찼습니다 (초기화 ${formatDate(exhaustedResetAt)}). 고정을 해제하거나 다른 계정으로 바꾸기 전까지 이 세션의 실행은 계속 거부됩니다.`,
              `Usage limit for the pinned account is fully exhausted (resets ${formatDate(exhaustedResetAt)}). Execution of this session will continue to be rejected until unpinned or switched to another account.`,
            )
          : text(
              "고정된 계정의 사용량 한도가 모두 찼습니다. 고정을 해제하거나 다른 계정으로 바꾸기 전까지 이 세션의 실행은 계속 거부됩니다.",
              "Usage limit for the pinned account is fully exhausted. Execution of this session will continue to be rejected until unpinned or switched to another account.",
            )}
      </small>}
    </SessionDetailCard>
  );
}

function pinnedAccountExhaustedResetAt(
  accounts: ProviderAccountView[] | null,
  pinnedAccountId: string | null,
  nowMs: number,
): number | null {
  if (!pinnedAccountId || !accounts) return null;
  const pinned = accounts.find((candidate) => candidate.id === pinnedAccountId);
  if (!pinned) return null;
  // 모델별 창은 그 모델을 쓰는 실행만 막으므로 고정 경고의 근거가 되지 않는다. 모델군
  // 창을 합쳐 만든 대표 창도 마찬가지다 — 한 모델군이 찼다고 경고를 띄우면 다른 모델군으로
  // 멀쩡히 도는 계정을 못 쓰는 것처럼 말하게 된다. 다시 열리는 시각까지 실행 게이트와 같은
  // 규칙으로 구한다(`accountExhaustionResetAt`).
  return accountExhaustionResetAt(displayUsageWindows(pinned.usage.windows, nowMs));
}

/** 읽기 전용 상세정보 표. 메시지 수는 목록 값이 없을 때만 원문에서 세므로 여기서 구한다. */
function SessionDetailFacts({ session, meta, detail, attachedCwd }: {
  session: SessionSummary;
  meta: SessionMeta;
  detail: SessionDetail | null;
  attachedCwd: string | null;
}) {
  const { text } = useI18n();
  const messageCount = session.messageCount ?? conversationMessageCount(detail);

  return (
    <SessionDetailCard name="session-detail-settings" title={text("상세정보", "Details")}>
      <div className="meta-grid">
        <Info label={text("프로젝트", "Project")} value={session.project ?? "–"} />
        <Info label={text("경로", "Path")} value={session.cwd || attachedCwd ? displayPath(session.cwd ?? attachedCwd ?? "") : "–"} mono />
        <Info label={text("세션 ID", "Session ID")} value={session.id} mono />
        <Info label={text("모델", "Model")} value={session.model ?? "–"} mono />
        <Info label={text("추론 수준", "Reasoning effort")} value={meta.reasoningEffort ? reasoningLabel(meta.reasoningEffort) : text("기본", "Default")} />
        <Info label={text("브랜치", "Branch")} value={session.gitBranch ?? "–"} mono />
        <Info label={text("메시지", "Messages")} value={messageCount?.toLocaleString() ?? "–"} />
        <Info label={text("토큰", "Tokens")} value={formatTokens(session.tokenTotal)} />
        <Info label={text("파일", "Files")} value={formatBytes(session.sizeBytes)} />
        <Info label={text("요청일시", "Requested")} value={formatDate(session.startedAt)} />
        <Info label={text("업데이트", "Updated")} value={formatDate(session.updatedAt)} />
      </div>
    </SessionDetailCard>
  );
}

/**
 * 이어가기 실행 설정 메뉴가 그대로 받아 가는 한 벌. 값 열 개와 변경 손잡이 다섯 개가
 * 작성기를 거치기만 할 뿐 작성기 자신이 보는 것은 공급자 하나라, 낱개로 늘어놓는 대신
 * 한 덩어리로 묶어 넘긴다.
 */
interface ContinuationRuntimeSettings {
  source: ProviderId;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  modelOptions: ChatModelCatalogOption[];
  recentModels: ModelOption[];
  reasoningEffort: ReasoningEffort | "";
  reasoningOptions: ChatReasoningOption[];
  settingFields: ChatSettingField[];
  extraSettings: Record<string, string>;
  onModeChange: (mode: ChatMode) => void;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | "") => void;
  onExtraSettingsApply: (settings: Record<string, string>) => void;
}

/**
 * 이어가기 한 벌에서 작성기가 받아 갈 실행 설정만 추린다. 열다섯 줄짜리 객체가 드로어
 * 본문의 작성기 호출 안에 그대로 들어앉아 있어, 설정 칸이 하나 늘 때마다 본문이 함께
 * 길어졌다. 고르는 규칙은 이름 하나로 두고 본문에는 그 이름만 남긴다.
 */
function continuationRuntimeSettings(continuation: SessionContinuation): ContinuationRuntimeSettings {
  return {
    source: continuation.source,
    mode: continuation.mode,
    approvalMode: continuation.approvalMode,
    model: continuation.model,
    modelOptions: continuation.modelOptions,
    recentModels: continuation.recentModels,
    reasoningEffort: continuation.reasoningEffort,
    reasoningOptions: continuation.reasoningOptions,
    settingFields: continuation.settingFields,
    extraSettings: continuation.extraSettings,
    onModeChange: (mode) => void continuation.changeMode(mode),
    onApprovalModeChange: (mode) => void continuation.changeApprovalMode(mode),
    onModelChange: (model) => void continuation.changeModel(model),
    onReasoningEffortChange: (effort) => void continuation.changeReasoningEffort(effort),
    onExtraSettingsApply: (settings) => void continuation.changeExtraSettings(settings),
  };
}

interface ContinuationComposerState {
  responding: boolean;
  modeLocked: boolean;
  canCompose: boolean;
  planRestartLocked: boolean;
  placeholder: string;
}

/** 이어가기 작성기의 실행 단계별 잠금과 안내 문구를 한 판정에서 만든다. */
function continuationComposerState(
  source: ProviderId,
  phase: ContinuationPhase,
  uploading: boolean,
  agentHandoff: boolean,
  blockedReason: string | null,
  planApprovalPending: boolean,
): ContinuationComposerState {
  const responding = isRespondingPhase(phase);
  return {
    responding,
    modeLocked: isBusyPhase(phase),
    canCompose: !blockedReason && phase !== "connecting" && !uploading,
    planRestartLocked: phase === "connecting" || (responding && !planApprovalPending),
    placeholder: blockedReason
      ?? (phase === "connecting"
        ? runtimeText("기존 대화에 연결하고 있습니다", "Connecting to existing conversation")
        : phase === "running"
          ? runtimeText("응답 중입니다. 지금 보내면 대기열에 추가됩니다", "Responding. Sending now will add to queue")
          : phase === "waitingApproval"
            ? runtimeText("승인 대기 중입니다. 지금 보내면 대기열에 추가됩니다", "Waiting for approval. Sending now will add to queue")
            : agentHandoff
              ? runtimeText(`${sourceName(source)}의 새 세션으로 인계할 요청을 입력하세요`, `Enter request to hand off to a new ${sourceName(source)} session`)
              : runtimeText("이 세션에 이어서 메시지를 입력한 뒤 전송 버튼을 누르세요", "Type a message to continue in this session, then click send")),
  };
}

/**
 * 이어가기 작성기. 그리는 값도 손잡이도 모두 이어가기 한 벌에서 나오는데, 예전에는 그
 * 스물세 칸을 드로어가 낱개로 펼쳐 넘겼다. 같은 이름표가 훅이 돌려주는 자리·이 컴포넌트의
 * 인자 표·드로어의 호출부 세 벌로 늘어서 있어, 칸이 하나 늘 때마다 세 자리를 함께 고쳐야
 * 했고 한 자리만 빠뜨리면 조용히 옛 값을 그렸다. 설정 판은 이미 한 벌을 통째로 받고
 * 있었으므로(`SessionDrawerSettingsPanel`) 작성기도 같은 모양으로 맞춘다. 실행 설정 메뉴를
 * 열 때 최신 스키마를 다시 읽는 일도 이어가기 한 벌만 있으면 되는 일이라 여기로 내린다.
 */
function SessionContinuationComposer({ continuation }: { continuation: SessionContinuation }) {
  const { text } = useI18n();
  const { source, phase, uploading, error } = continuation;
  const blockedReason = continuation.target.blocked?.reason ?? null;
  /** 지금 계획 승인을 기다리는 중인가. 그때만 요청 모드를 바꿔 계획을 넘길 수 있다. */
  const planApprovalPending = continuation.pendingPlanApproval !== null;
  const { responding, modeLocked, canCompose, planRestartLocked, placeholder } = continuationComposerState(
    source,
    phase,
    uploading,
    continuation.agentHandoffPending,
    blockedReason,
    planApprovalPending,
  );
  return (
    <div className="session-continuation-footer">
      <ChatRuntimeSettingsMenu
        {...continuationRuntimeSettings(continuation)}
        panelId="session-runtime-settings-panel"
        contextLabel={text("이어가기", "Continuation")}
        locked={modeLocked}
        planRestartLocked={planRestartLocked}
        planRestartNote={planApprovalPending
          ? text("계획 승인 중입니다. 지금 요청 모드를 바꾸면 이 실행은 계획을 승인하지 않고 접히고, 계획이 새 실행으로 넘어갑니다.", "Awaiting plan approval. Changing request mode now closes this run without approving the plan and carries it to a new run.")
          : undefined}
        statusIndicator={<span className={`terminal-status terminal-status-${phase}`} />}
        contextMeter={<ChatContextMeter usedTokens={continuation.displayedContextUsedTokens} windowTokens={continuation.contextWindowTokens} />}
        statusLabel={blockedReason
          ? <small>{blockedReason}</small>
          : <small>{continuationPhaseLabel(phase)}</small>}
        onOpen={() => {
          void refreshProviderOptions(source).catch((cause) => {
            continuation.setError(text(`최신 실행 설정을 불러오지 못했습니다: ${errorText(cause)}`, `Failed to load latest execution settings: ${errorText(cause)}`));
          });
        }}
      />
      {continuation.largeContextWarning && <div className="session-context-warning" role="status">{continuation.largeContextWarning}</div>}
      {error && <ErrorBanner message={error} />}
      <ChatComposer
        className="session-chat-composer"
        ariaLabel={text("세션 대화 이어가기", "Continue session conversation")}
        value={continuation.text}
        attachments={continuation.attachments}
        uploading={uploading}
        busy={responding}
        canCompose={canCompose}
        rows={1}
        placeholder={placeholder}
        queue={continuation.queue}
        canDeliver={supportsDeliveryDuringTurn(source)}
        onChange={continuation.setText}
        onAddFiles={continuation.addFiles}
        onRemoveAttachment={continuation.removeAttachment}
        onSubmit={continuation.submit}
        onQueue={() => void continuation.deliver(false)}
        onDeliver={() => void continuation.deliver(true)}
        onInterrupt={continuation.interrupt}
        onRemoveQueued={(messageId) => void continuation.removeQueued(messageId)}
        onRecallQueued={(item) => void continuation.recallQueued(item)}
      />
    </div>
  );
}

function continuationPhaseLabel(phase: ContinuationPhase): string {
  if (phase === "idle") return runtimeText("입력 대기", "Waiting for input");
  if (phase === "connecting") return runtimeText("기존 세션 연결 중", "Connecting to session");
  if (phase === "ready") return runtimeText("입력 대기", "Waiting for input");
  if (phase === "running") return runtimeText("응답 중", "Responding");
  if (phase === "waitingApproval") return runtimeText("승인 대기", "Waiting for approval");
  if (phase === "stopped") return runtimeText("연결 종료", "Disconnected");
  return runtimeText("연결 오류", "Connection error");
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
