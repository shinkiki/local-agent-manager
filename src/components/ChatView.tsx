import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AppWindow, CalendarClock, ChevronDown, ChevronRight, ExternalLink, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, ScrollText, X } from "lucide-react";
import { attachChat, connectChat, supportsDeliveryDuringTurn, type ChatConnection } from "../lib/chat";
import { ChatRejectedError } from "../lib/chatReconnect";
import type { TabRequest } from "../lib/uiGuide";
import {
  createDirectory,
  downloadChatLinkedFile,
  getChatLinkedFile,
  getDetachedChatForSession,
  getLiveChats,
  hasTauriRuntime,
  openProviderSessionApp,
} from "../lib/ipc";
import { formatDate } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { missingDirectoryPath, missingDirectoryPrompt } from "../lib/missingDirectory";
import { liveStreamBoundaryMs, transcriptBeforeLiveStream } from "../lib/transcriptOverlap";
import {
  ActivityFilterSelect,
  TranscriptLimitSelect,
  TranscriptLoadEarlier,
  TranscriptTurns,
  useSessionTranscript,
} from "./SessionTranscript";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatApprovalDecision,
  ChatEvent,
  ChatMode,
  ChatPhase,
  ChatSessionInfo,
  MessageDisplayMode,
  ModelOption,
  ProjectOption,
  ProviderId,
  ProviderStatus,
  QueuedChatMessage,
  ReasoningEffort,
  SchedulerSnapshot,
  SessionSummary,
  SessionTranscriptLimit,
  TranscriptItem,
} from "../types";
import { ChatApprovalDock, ChatContextMeter, ErrorBanner, EmptyState, SourceBadge, useConfirm, useEscapeToClose } from "./Shared";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { ChatRuntimeSettingsMenu, type ChatAgentChoice } from "./ChatRuntimeSettingsMenu";
import {
  appendAttachmentDrafts,
  AttachmentPicker,
  clipboardFiles,
  queuedAttachmentsToDrafts,
  releaseAttachmentDraftUpload,
  uploadAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { ChatComposer } from "./ChatComposer";
import { SchedulesPanel } from "./ChatSchedules";
import {
  applyChatEvent,
  ChatConversationTurn,
  ChatEntryView,
  ChatScrollControls,
  chatTurnStatusLabel,
  lastUserMessageKey,
  scrollToLastUserMessage,
  type ChatEntry,
  type ChatTurn,
} from "./ChatConversation";
import { accountName, activeAccountId, launchAccountChoices, resolveLaunchAccountId } from "../lib/launchAccount";
import { buildSessionHandoffMessage } from "../lib/sessionHandoff";
import { planExecutionRequest, planRestartMode } from "../lib/planRestart";
import { activityMatches, type ActivityFilter } from "../lib/activityFilter";
import {
  approvalModeLabel,
  defaultApprovalMode,
  normalizeExtraSettings,
  normalizeSettingValue,
  permissionModeLabel,
  reasoningLabel,
  sameChatSettings,
  settingField,
  settingFieldsFor,
} from "../lib/chatSettings";
import { submitComposerOnEnter } from "../lib/composerKeys";
import { shouldApplyLivePhaseSnapshot } from "../lib/livePhaseSync";
import { usePoll } from "../lib/poll";
import { openPopoutWindow, usePopoutWindowTitle } from "../lib/popoutWindow";
import { reasoningOptionsFor, refreshProviderOptions, useProviderOptions } from "../lib/providerOptions";
import { defaultEffortFor, runtimeExtraSettingFields, RuntimeExtraSettings, RuntimeSettings } from "./RuntimeSettings";
import { readSecondaryPaneOpen, writeSecondaryPaneOpen } from "../lib/secondaryPane";
import { hideChatCloseConfirmation, shouldConfirmChatClose } from "../lib/chatCloseConfirmation";
import { errorText } from "../lib/errorText";

interface ChatViewProps {
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  projects: ProjectOption[];
  models: ModelOption[];
  sessions: SessionSummary[];
  messageDisplayMode: MessageDisplayMode;
  /** 세션 상세와 공유하는 대화 원문 표시 범위. 소유는 App에 있다. */
  transcriptLimit: SessionTranscriptLimit;
  onTranscriptLimitChange: (limit: SessionTranscriptLimit) => void;
  /** App의 10초 폴링이 받는 스냅샷을 그대로 쓴다. 패널이 따로 폴링하지 않는다. */
  scheduler: SchedulerSnapshot | null;
  onRefreshScheduler: () => Promise<void>;
  /**
   * 반복 요청을 바꾼 직후 목록 전체를 다시 받지 않고 스냅샷만 갈아 끼운다. 값이 아니라
   * 갱신 함수를 받아, 동시에 두 항목을 눌러도 서로의 변경을 덮지 않는다.
   */
  onSchedulerSnapshot: (update: (current: SchedulerSnapshot) => SchedulerSnapshot) => void;
  onConnectCli: (provider: ProviderStatus) => void;
  onOpenSession: (session: SessionSummary) => void;
  onSessionCatalogChanged: (source: ProviderId, id: string) => Promise<void>;
  attentionTarget: ChatViewAttentionTarget | null;
  onAttentionTargetHandled: (target: ChatViewAttentionTarget, opened: boolean) => void;
  /** 다른 화면(대시보드 반복 일정, AIA 화면 안내)이 특정 탭을 열어 달라는 요청. */
  tabRequest?: TabRequest<ChatTab> | null;
  /** 이 화면이 이미 팝아웃 창일 때는 '새 창으로 열기'를 다시 제공하지 않는다. */
  popout?: boolean;
}

export interface ChatViewAttentionTarget {
  chatId: string;
  attentionId: string;
  markRead: boolean;
  requestId: number;
}

export type ChatTab = "conversation" | "activity" | "schedules";

const MANUAL_CWD = "__manual_cwd__";
const CHAT_LIST_OPEN_KEY = "agent-manager.chat-list-pane";
const HIDDEN_CLI_CONNECTION_CARDS_KEY = "agent-manager.hidden-cli-connection-cards.v1";
const PLAN_RESTART_CONFIRM_LABEL = "이 계획으로 다시 시작";

/**
 * 계획을 다른 실행으로 넘기는 확인 창이 공통으로 말하는 것: 지금 실행은 승인 없이 접히고,
 * 그래서 아직 아무것도 실행되지 않았다. 앞머리만 갈래마다 다르다.
 */
function planHandoffMessage(lead: string, notice = ""): string {
  return `${lead}\n지금 실행은 계획을 승인하지 않고 접히므로 아직 아무것도 실행되지 않습니다.${notice}`;
}

/**
 * detach는 이미 끝난 프로세스의 이벤트 구독을 끊는 뒷정리라, 실패해도 되돌릴 것이 없고
 * 사용자에게 알릴 것도 없다. 호출부마다 같은 문장을 다르게 적기보다 여기서 한 번 삼킨다.
 */
async function detachQuietly(connection: ChatConnection | null): Promise<void> {
  if (!connection) return;
  try {
    await connection.detach();
  } catch {
    // 이미 사라진 프로세스에 대한 detach 실패는 정리가 끝난 것과 같다.
  }
}

/** 종료 실패를 알릴 자리가 없는 정리 경로에서만 쓴다 — 프로세스가 이미 없을 수 있다. */
async function stopQuietly(connection: ChatConnection): Promise<void> {
  try {
    await connection.stop();
  } catch {
    // 실행이 이미 끝났다면 종료 요청 실패는 원하던 상태와 같다.
  }
}

/**
 * 활성 채팅 하나가 화면에서 차지하는 상태 묶음. 대화·대기열·작성 중인 글·단계·진행 중인
 * 턴은 언제나 한 채팅의 것이라 따로 움직인 적이 없는데도, 전환·재시작·종료 경로마다
 * 열한 줄짜리 대입이 되풀이되고 한 줄이라도 빠지면 이전 채팅의 잔상이 남았다.
 * 화면 상태는 이 한 벌로 읽고 쓴다.
 */
interface ChatSurface {
  turns: ChatTurn[];
  queue: QueuedChatMessage[];
  composer: string;
  attachments: ChatAttachmentDraft[];
  phase: ChatPhase | "connecting";
  activeTurnId: string | null;
}

/**
 * 아직 붙지 않은 채팅의 화면 상태. 대화와 대기열은 연결이 리플레이로 채우므로 비우고,
 * 작성 중이던 글만 그 채팅 몫으로 기억해 둔 초안에서 되살린다.
 */
function connectingChatSurface(draft?: { text: string; attachments: ChatAttachmentDraft[] }): ChatSurface {
  return {
    turns: [],
    queue: [],
    composer: draft?.text ?? "",
    attachments: draft?.attachments ?? [],
    phase: "connecting",
    activeTurnId: null,
  };
}

/**
 * 로컬 저장소는 브라우저 설정·용량에 따라 읽기와 쓰기 어느 쪽도 던질 수 있고, 담긴 값은
 * 지난 버전이 남긴 아무 모양이나 될 수 있다. 이 화면이 저장하는 것은 모두 화면 설정이라
 * 실패해도 이번 실행을 막지 않아야 하므로, 네 곳에 흩어져 있던 같은 try/catch 껍데기를
 * 여기 한 벌로 모은다. 값의 모양 검사는 그대로 각 호출부가 한다.
 */
function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 쓸 수 없는 환경에서도 이번 실행의 화면 동작은 그대로 유지한다.
  }
}

function readHiddenCliConnectionCards(): ProviderId[] {
  const stored = readStoredJson<unknown>(HIDDEN_CLI_CONNECTION_CARDS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((provider): provider is ProviderId => provider === "claude" || provider === "codex" || provider === "antigravity");
}

function writeHiddenCliConnectionCards(providers: ProviderId[]): void {
  writeStoredJson(HIDDEN_CLI_CONNECTION_CARDS_KEY, providers);
}

export function ChatView({ providers, accounts, projects, models, sessions, messageDisplayMode, transcriptLimit, onTranscriptLimitChange, scheduler, onRefreshScheduler, onSchedulerSnapshot, onConnectCli, onOpenSession, onSessionCatalogChanged, attentionTarget, onAttentionTargetHandled, tabRequest = null, popout = false }: ChatViewProps) {
  // 정적 치환기는 화면에 그려지는 텍스트 노드만 덮는다. aria-label·title·placeholder처럼
  // 속성으로만 있는 문구는 여기서 text(ko, en)으로 직접 고른다.
  const { text } = useI18n();
  const available = useMemo(() => providers.filter((provider) => provider.cli.detected), [providers]);
  const unavailable = useMemo(() => providers.filter((provider) => !provider.cli.detected), [providers]);
  const [hiddenCliConnectionCards, setHiddenCliConnectionCards] = useState<ProviderId[]>(readHiddenCliConnectionCards);
  const [rememberHiddenCliConnectionCards, setRememberHiddenCliConnectionCards] = useState<ProviderId[]>([]);
  const visibleUnavailable = useMemo(
    () => unavailable.filter((provider) => !hiddenCliConnectionCards.includes(provider.provider)),
    [hiddenCliConnectionCards, unavailable],
  );
  const closeCliConnectionCard = (provider: ProviderId) => {
    setHiddenCliConnectionCards((current) => {
      if (current.includes(provider)) return current;
      const next = [...current, provider];
      if (rememberHiddenCliConnectionCards.includes(provider)) writeHiddenCliConnectionCards(next);
      return next;
    });
  };
  const initialSource = available[0]?.provider ?? "codex";
  const [tab, setTab] = useState<ChatTab>("conversation");
  const [chatListOpen, setChatListOpen] = useState(() => !popout && readSecondaryPaneOpen(CHAT_LIST_OPEN_KEY));
  const chatListCloseRef = useRef<HTMLButtonElement>(null);
  const chatListRestoreRef = useRef<HTMLButtonElement>(null);
  const chatListFocusTargetRef = useRef<"close" | "restore" | null>(null);
  // 좁은 화면에서만 채팅 목록이 본문을 덮는 오버레이가 된다. 그때만 Esc로 닫고,
  // 넓은 화면의 붙박이 사이드바일 때는 Esc를 가로채지 않는다.
  const [chatListIsOverlay, setChatListIsOverlay] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setChatListIsOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!popout) writeSecondaryPaneOpen(CHAT_LIST_OPEN_KEY, chatListOpen);
  }, [chatListOpen, popout]);
  useLayoutEffect(() => {
    const target = chatListFocusTargetRef.current;
    if (!target) return;
    chatListFocusTargetRef.current = null;
    if (target === "close") chatListCloseRef.current?.focus();
    else chatListRestoreRef.current?.focus();
  }, [chatListOpen]);
  const setChatListVisibility = (open: boolean) => {
    chatListFocusTargetRef.current = open ? "close" : "restore";
    setChatListOpen(open);
  };
  const closeChatListAndRestoreFocus = () => {
    setChatListVisibility(false);
  };
  useEscapeToClose(closeChatListAndRestoreFocus, chatListOpen && chatListIsOverlay && !popout);
  // 대시보드 '반복 일정' 패널에서 넘어온 요청은 반복 요청 탭을 바로 연다.
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  const [source, setSource] = useState<ProviderId>(initialSource);
  // 빈 값은 "실행 시점 기본 계정"이라는 기본 선택이다. 특정 계정을 고르면 그 계정으로만 실행한다.
  const [launchAccountId, setLaunchAccountId] = useState("");
  const [cwd, setCwd] = useState(projects[0]?.path ?? "");
  const [manualCwd, setManualCwd] = useState(false);
  const [model, setModel] = useState(() => readChatLaunchSettings(initialSource).model);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(() => readChatLaunchSettings(initialSource).reasoningEffort);
  const [mode, setMode] = useState<ChatMode>("workspace");
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode>(defaultApprovalMode(initialSource));
  const [extraSettings, setExtraSettings] = useState<Record<string, string>>({});
  const [initialPrompt, setInitialPrompt] = useState("");
  const [initialAttachments, setInitialAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [composer, setComposer] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [session, setSession] = useState<ChatSessionInfo | null>(null);
  const [liveChats, setLiveChats] = useState<ChatSessionInfo[]>([]);
  // 종료를 요청한 배경 채팅. 3초 폴링이 아직 살아 있는 그 채팅을 목록에 되살리지 못하게
  // 화면에서만 걸러 낸다. 실패하면 다시 목록에 나타난다.
  const [closingChatIds, setClosingChatIds] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, setPhase] = useState<ChatPhase | "connecting">("connecting");
  const [queue, setQueue] = useState<QueuedChatMessage[]>([]);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [error, setError] = useState<string | null>(null);
  /**
   * 첨부 거절 안내. 시작·연결 오류(`error`)와 자리를 나눈다 — 한 자리에 실으면 거절 뒤에
   * 정상 첨부를 이어 담아도 안내가 남고, 반대로 첨부를 담을 때 연결 오류를 지워 버린다.
   * 거절이 없는 담기는 이전 거절 안내를 지운다.
   */
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // 실행 계정은 CLI 프로세스가 뜰 때 고정되어 시작 뒤에는 바꿀 수 없으므로 접지 않고 본문에 둔다.
  // 접이식 고급 옵션에는 시작 뒤에도 실행 설정 메뉴에서 바꿀 수 있는 추가 스키마 항목만 남긴다.
  const [launchAdvancedOpen, setLaunchAdvancedOpen] = useState(false);
  const [chatSwitching, setChatSwitching] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [openingProviderApp, setOpeningProviderApp] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const connectionRef = useRef<ChatConnection | null>(null);
  const connectionGenerationRef = useRef(0);
  /**
   * 연결 세대를 한 칸 올리고 새 번호를 돌려준다. 세대를 올리면 이전 연결에서 뒤늦게
   * 도착하는 이벤트가 세대 검사에 걸려 버려진다 — 올리기와 읽기가 떨어져 있으면 그 사이에
   * 낀 다른 전환이 같은 번호를 두 연결에 쥐여 준다.
   */
  const bumpConnectionGeneration = (): number => {
    connectionGenerationRef.current += 1;
    return connectionGenerationRef.current;
  };
  /**
   * 지금 붙어 있는 연결을 화면에서 떼어낸다. 세대를 먼저 올려 이 연결에서 뒤늦게 도착하는
   * 이벤트를 버리게 한 다음 참조를 비우고 detach한다 — 순서가 뒤집히면 정리 도중 들어온
   * 이벤트가 이미 지운 대화에 다시 붙는다. 새로 쓸 세대 번호를 돌려준다.
   */
  const retireConnection = async (connection: ChatConnection | null): Promise<number> => {
    const generation = bumpConnectionGeneration();
    connectionRef.current = null;
    await detachQuietly(connection);
    return generation;
  };
  /**
   * 에이전트를 바꿔 새로 띄운 세션에 아직 넘기지 못한 인계 문맥. 다음 전송 한 번에만
   * 실려 나가고 지워진다 — 매 전송마다 붙이면 새 세션의 컨텍스트를 계속 갉아먹는다.
   */
  const pendingHandoffRef = useRef<{ source: ProviderId; id: string; transcript: TranscriptItem[] } | null>(null);
  const sessionRef = useRef<ChatSessionInfo | null>(null);
  const phaseRef = useRef<ChatPhase | "connecting">("connecting");
  const turnsRef = useRef<ChatTurn[]>([]);
  const queueRef = useRef<QueuedChatMessage[]>([]);
  const composerRef = useRef("");
  const composerAttachmentsRef = useRef<ChatAttachmentDraft[]>([]);
  const chatDraftsRef = useRef(new Map<string, { text: string; attachments: ChatAttachmentDraft[] }>());
  const chatScrollPositionsRef = useRef(new Map<string, number>());
  const chatSwitchingRef = useRef(false);
  const resumingRef = useRef(false);
  // 채팅 전환 요청을 순서대로 처리하기 위한 꼬리 promise.
  const chatSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());
  // 라이브 state 이벤트를 이미 반영한 연결 세대. attach 응답의 스냅숏이 이보다
  // 과거인지 판단하는 데 쓴다.
  const appliedStateGenerationRef = useRef(-1);
  // 마지막으로 반영한 라이브 state 이벤트 시각. 폴링 스냅숏이 그보다 먼저 조회된
  // 것이면 이미 지난 상태이므로 덮어쓰지 않는다.
  const lastStateEventAtRef = useRef(0);
  const settingsChangeRef = useRef(false);
  const activeTurnRef = useRef<string | null>(null);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const activityLogRef = useRef<HTMLDivElement>(null);
  const followLatestMessagesRef = useRef(messageDisplayMode === "latest");
  const handledLastUserMessageRef = useRef(new Map<string, string>());

  /** 지금 화면에 떠 있는 채팅 상태를 통째로 떠 둔다. 되돌릴 자리에 그대로 넘기면 복원이 된다. */
  const captureChatSurface = useCallback((): ChatSurface => ({
    turns: turnsRef.current,
    queue: queueRef.current,
    composer: composerRef.current,
    attachments: composerAttachmentsRef.current,
    phase: phaseRef.current,
    activeTurnId: activeTurnRef.current,
  }), []);

  /**
   * 화면 상태를 한 벌로 갈아 끼운다. 값마다 ref와 state를 짝으로 들고 있는 것은 이벤트
   * 처리기가 렌더를 기다리지 않고 최신 값을 읽어야 하기 때문이고, 그래서 둘을 함께
   * 옮기는 일이 어느 경로에서도 빠지면 안 된다.
   */
  const applyChatSurface = useCallback((surface: ChatSurface) => {
    turnsRef.current = surface.turns;
    queueRef.current = surface.queue;
    setTurns(surface.turns);
    setQueue(surface.queue);
    composerRef.current = surface.composer;
    composerAttachmentsRef.current = surface.attachments;
    setComposer(surface.composer);
    setComposerAttachments(surface.attachments);
    phaseRef.current = surface.phase;
    setPhase(surface.phase);
    activeTurnRef.current = surface.activeTurnId;
  }, []);

  /**
   * 채팅을 떠나기 전에 작성 중이던 글과 스크롤 위치를 그 채팅 몫으로 남긴다. 돌아올 때
   * `connectingChatSurface`가 이 초안을 다시 입력창에 올린다.
   */
  const rememberChatLocalState = useCallback((chatId: string) => {
    chatDraftsRef.current.set(chatId, { text: composerRef.current, attachments: composerAttachmentsRef.current });
    chatScrollPositionsRef.current.set(chatId, chatStreamRef.current?.scrollTop ?? 0);
  }, []);

  /**
   * 다시 열릴 일이 없는 chatId가 남긴 기억을 지운다. 초안·스크롤 위치·마지막 사용자 메시지
   * 표시는 모두 chatId를 열쇠로 쓰는데, 종료했거나 재개로 새 chatId를 받은 런타임의 열쇠는
   * 다시 나타나지 않아 지우지 않으면 그대로 쌓인다.
   */
  const forgetChatLocalState = useCallback((chatId: string) => {
    chatDraftsRef.current.delete(chatId);
    chatScrollPositionsRef.current.delete(chatId);
    handledLastUserMessageRef.current.delete(chatId);
  }, []);

  const providerOptions = useProviderOptions(source);
  // 새 채팅의 실행 계정 선택지. 계정 스냅샷이 바뀌어 고른 계정이 사라지거나 막히면
  // 기본값(활성 계정)으로 되돌려, 화면에 없는 계정으로 시작 요청을 보내지 않는다.
  const accountChoices = useMemo(() => launchAccountChoices(accounts, source), [accounts, source]);
  // 고급 옵션에 남는 항목은 공급자 스키마가 주는 추가 실행 설정뿐이다.
  const launchExtraFields = useMemo(() => runtimeExtraSettingFields(providerOptions, source), [providerOptions, source]);
  const launchActiveAccountId = useMemo(() => activeAccountId(accounts, source), [accounts, source]);
  useEffect(() => {
    setLaunchAccountId((current) => resolveLaunchAccountId(current, accountChoices));
  }, [accountChoices]);
  const activeChatId = session?.chatId ?? null;
  const openChats = useMemo(() => {
    const visible = closingChatIds.size === 0
      ? liveChats
      : liveChats.filter((chat) => !closingChatIds.has(chat.chatId));
    if (!session || visible.some((chat) => chat.chatId === session.chatId)) return visible;
    return [...visible, session];
  }, [closingChatIds, liveChats, session]);
  const loadLinkedFile = useCallback((href: string) => {
    if (!activeChatId) return Promise.reject(new Error("연결된 채팅을 찾을 수 없습니다."));
    return getChatLinkedFile(activeChatId, href);
  }, [activeChatId]);
  const downloadLinkedFile = useCallback((href: string) => {
    if (!activeChatId) return Promise.reject(new Error("연결된 채팅을 찾을 수 없습니다."));
    return downloadChatLinkedFile(activeChatId, href);
  }, [activeChatId]);
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);

  // 탭마다 스크롤을 맡는 요소가 다르다. 훅은 이전 구간을 붙인 뒤 위치를 되돌릴 때만 읽으므로
  // 그 시점의 활성 탭 컨테이너를 돌려주는 프록시를 넘긴다.
  const historyScrollRef = useMemo(() => ({
    get current(): HTMLElement | null {
      return tab === "activity" ? activityLogRef.current : chatStreamRef.current;
    },
  }), [tab]);
  /**
   * 라이브 스트림이 대화의 처음부터를 담고 있으면 파일 원문을 읽을 이유가 없다. 리플레이
   * 버퍼가 앞부분을 밀어냈거나(재접속·긴 대화) 기존 세션을 이어 시작한 채팅만 원문을 읽는다.
   */
  const liveStreamMissesHistory = Boolean(session && (session.replayTruncated || session.resuming));
  /**
   * 세션 파일에 남은 원문을 스트림 위에 붙이고, 라이브가 이미 담당하는 구간은 세션 상세와
   * 같은 경계 계산으로 잘라내 같은 턴이 두 번 보이지 않게 한다.
   */
  const transcript = useSessionTranscript({
    source: session?.source ?? null,
    sessionId: liveStreamMissesHistory ? session?.providerSessionId ?? null : null,
    limit: transcriptLimit,
    scrollContainerRef: historyScrollRef,
  });
  const liveStreamBoundary = useMemo(() => liveStreamBoundaryMs(turns), [turns]);
  const visibleTranscript = useMemo(
    () => transcriptBeforeLiveStream(transcript.detail?.transcript ?? [], liveStreamBoundary),
    [transcript.detail, liveStreamBoundary],
  );

  const switchSource = useCallback((nextSource: ProviderId) => {
    setSource(nextSource);
    // 계정은 공급자에 묶여 있으므로 공급자를 바꾸면 기본값(활성 계정)으로 되돌린다.
    setLaunchAccountId("");
    setApprovalMode(defaultApprovalMode(nextSource));
    setExtraSettings({});
    const stored = readChatLaunchSettings(nextSource);
    setModel(stored.model);
    setReasoningEffort(stored.reasoningEffort);
  }, []);

  const updateLiveChat = useCallback((info: ChatSessionInfo) => {
    setLiveChats((current) => {
      if (info.profile !== "standard" || info.state === "stopped" || info.state === "failed") {
        return current.filter((chat) => chat.chatId !== info.chatId);
      }
      // 기존 항목은 제자리에서 교체해 상태 이벤트가 올 때마다 목록 순서가 바뀌지 않게 한다.
      const index = current.findIndex((chat) => chat.chatId === info.chatId);
      if (index < 0) return [...current, info];
      return current.map((chat, position) => (position === index ? info : chat));
    });
  }, []);

  const applySessionInfo = useCallback((info: ChatSessionInfo) => {
    sessionRef.current = info;
    phaseRef.current = info.state;
    setSession(info);
    setPhase(info.state);
    setSource(info.source);
    setCwd(info.cwd);
    setModel(info.model ?? "");
    setReasoningEffort(info.reasoningEffort ?? "");
    setMode(info.mode);
    setApprovalMode(info.approvalMode);
    setExtraSettings(info.settings ?? {});
    updateLiveChat(info);
  }, [updateLiveChat]);

  /**
   * attach·connect 응답의 `info`는 서버가 보낸 **첫** state 이벤트의 스냅숏이다.
   * 리플레이 끝에 붙는 현재 state를 이미 반영한 뒤라면 이 값은 과거 상태이므로
   * 덮어쓰지 않는다. 실행 중인 채팅에 연결했는데 머리말과 입력창이 '입력 대기'로
   * 되돌아가(전송 버튼이 중단으로 바뀌지 않던) 문제를 막는다.
   */
  const applyAttachSnapshot = useCallback((info: ChatSessionInfo, generation: number) => {
    if (appliedStateGenerationRef.current === generation) return;
    applySessionInfo(info);
  }, [applySessionInfo]);

  const refreshLiveChats = useCallback(async () => {
    // 스냅숏은 이 시각의 사진이다. 응답을 기다리는 사이에 도착한 state 이벤트보다
    // 과거인지 판정하는 데 쓴다.
    const requestedAt = Date.now();
    // 화면의 채팅은 그대로 두고, 폴링 루프만 백오프하도록 실패를 전달한다.
    const chats = await getLiveChats("standard");
    setLiveChats(chats);
    // 안전망: 라이브 state 이벤트를 놓쳐 표시가 실제 상태와 어긋나면 스냅숏으로 맞춘다.
    const active = sessionRef.current;
    if (!active) return;
    const live = chats.find((chat) => chat.chatId === active.chatId);
    if (shouldApplyLivePhaseSnapshot({
      requestedAt,
      lastStateEventAt: lastStateEventAtRef.current,
      localPhase: phaseRef.current,
      snapshotPhase: live?.state ?? null,
      busyLocally: chatSwitchingRef.current || settingsChangeRef.current,
    }) && live) {
      applySessionInfo(live);
    }
  }, [applySessionInfo]);

  useEffect(() => {
    if (!session && available.length > 0 && !available.some((provider) => provider.provider === source)) {
      switchSource(available[0].provider);
    }
  }, [available, session, source, switchSource]);

  // 실행설정 스키마는 설치된 CLI를 조사해 갱신되므로, 예전 CLI에서 고른 값이 더 이상
  // 선택지에 없을 수 있다. 새 채팅 입력값만 정규화하고, 이미 실행 중인 세션은 백엔드가
  // 보고한 값을 그대로 보여준다.
  useEffect(() => {
    if (session) return;
    const fields = settingFieldsFor(providerOptions, source);
    setMode((current) => normalizeSettingValue(fields, "mode", current) as ChatMode);
    setApprovalMode((current) => normalizeSettingValue(fields, "approvalMode", current) as ChatApprovalMode);
    setExtraSettings((current) => {
      const next = normalizeExtraSettings(fields, current);
      return sameChatSettings(current, next) ? current : next;
    });
  }, [providerOptions, session, source]);

  usePoll(refreshLiveChats, 3_000);

  // 팝아웃 창 제목으로 어떤 대화를 띄운 창인지 구분한다.
  usePopoutWindowTitle(popout && session ? chatTabTitle(session, chatCatalogSession(session, sessions)) : null);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { composerAttachmentsRef.current = composerAttachments; }, [composerAttachments]);

  const handleEvent = useCallback((event: ChatEvent) => {
    applyChatEvent(event, {
      activeTurnRef,
      setTurns,
      setQueue,
      onState: (info) => {
        appliedStateGenerationRef.current = connectionGenerationRef.current;
        lastStateEventAtRef.current = Date.now();
        applySessionInfo(info);
        if (info.providerSessionId) void onSessionCatalogChanged(info.source, info.providerSessionId);
      },
      onError: setError,
    });
  }, [applySessionInfo, onSessionCatalogChanged]);

  /**
   * 주어진 세대에 묶인 이벤트 수신기를 만든다. 연결을 걸 때마다 세대 검사를 손으로 적으면
   * 한 곳만 빠져도 떠난 연결의 이벤트가 지금 대화에 섞인다.
   */
  const eventsForGeneration = (generation: number) => (event: ChatEvent) => {
    if (generation === connectionGenerationRef.current) handleEvent(event);
  };

  useEffect(() => {
    followLatestMessagesRef.current = messageDisplayMode === "latest";
  }, [activeChatId, messageDisplayMode]);

  const pauseFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = false;
  }, []);
  const resumeFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = messageDisplayMode === "latest";
  }, [messageDisplayMode]);

  useEffect(() => {
    if (messageDisplayMode !== "latest" || !followLatestMessagesRef.current || tab !== "conversation") return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!followLatestMessagesRef.current) return;
      const stream = chatStreamRef.current;
      if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [turns, tab, messageDisplayMode]);

  // '마지막 보낸 메시지부터' 모드: 채팅을 처음 열 때와 새 메시지를 보낼 때
  // 사용자 메시지가 화면 맨 위에 오도록 이동한다. 같은 위치는 다시 이동하지
  // 않으므로 응답이 흘러들어와도 읽던 자리가 밀리지 않는다.
  const lastUserMessageId = useMemo(() => lastUserMessageKey(turns), [turns]);
  useEffect(() => {
    if (messageDisplayMode !== "lastUser" || tab !== "conversation" || !activeChatId || !lastUserMessageId) return undefined;
    if (handledLastUserMessageRef.current.get(activeChatId) === lastUserMessageId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (scrollToLastUserMessage(chatStreamRef.current)) {
        handledLastUserMessageRef.current.set(activeChatId, lastUserMessageId);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageDisplayMode, tab, activeChatId, lastUserMessageId]);

  // 과거 구간이 위에 붙으면 스크롤 높이가 늘어나 읽던 자리가 밀린다. 원문이 처음 도착한
  // 시점에 메시지 표시 위치 설정을 다시 적용해 화면을 제자리에 맞춘다. 채팅마다 한 번만 한다.
  const historyPlacedChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (!transcript.detail || !activeChatId || historyPlacedChatRef.current === activeChatId) return undefined;
    historyPlacedChatRef.current = activeChatId;
    if (messageDisplayMode === "start") return undefined;
    const frame = window.requestAnimationFrame(() => {
      const container = tab === "activity" ? activityLogRef.current : chatStreamRef.current;
      if (!container) return;
      if (messageDisplayMode === "lastUser" && tab === "conversation" && scrollToLastUserMessage(container)) return;
      if (followLatestMessagesRef.current) container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeChatId, messageDisplayMode, tab, transcript.detail]);

  useEffect(() => () => {
    bumpConnectionGeneration();
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) void connection.detach();
  }, []);

  const runChatSwitch = useCallback(async (chatId: string): Promise<boolean> => {
    const connected = connectionRef.current;
    if (connected?.info.chatId === chatId) {
      setTab("conversation");
      return true;
    }

    chatSwitchingRef.current = true;
    setChatSwitching(true);
    const previous = connected;
    const previousInfo = sessionRef.current ?? previous?.info ?? null;
    const previousSurface = captureChatSurface();
    if (previousInfo) rememberChatLocalState(previousInfo.chatId);

    const generation = bumpConnectionGeneration();
    connectionRef.current = null;
    setTab("conversation");
    setError(null);
    applyChatSurface(connectingChatSurface(chatDraftsRef.current.get(chatId)));

    let detachedPrevious = false;
    try {
      if (previous) {
        await previous.detach();
        detachedPrevious = true;
      }
      const nextConnection = await attachChat(chatId, eventsForGeneration(generation));
      if (generation !== connectionGenerationRef.current) {
        // 이 창이 다시 마운트되었거나 다음 전환이 시작되어 이 연결의 이벤트는 세대 검사에서
        // 버려진다. 화면에 붙이면 세션 정보만 있고 대화는 비어 있는 상태로 남으므로,
        // 연결을 정리하고 실패로 알려 뒤에 큐에 든 전환이 다시 붙게 한다.
        await detachQuietly(nextConnection);
        return false;
      }
      connectionRef.current = nextConnection;
      applyAttachSnapshot(nextConnection.info, generation);
      const scrollTop = chatScrollPositionsRef.current.get(nextConnection.info.chatId);
      if (scrollTop !== undefined) {
        window.requestAnimationFrame(() => chatStreamRef.current?.scrollTo({ top: scrollTop, behavior: "auto" }));
      }
      return true;
    } catch (cause) {
      let restored = false;
      if (previousInfo && previous && detachedPrevious) {
        try {
          const previousGeneration = bumpConnectionGeneration();
          const previousConnection = await attachChat(previousInfo.chatId, eventsForGeneration(previousGeneration));
          connectionRef.current = previousConnection;
          applyAttachSnapshot(previousConnection.info, previousGeneration);
          // 스냅숏이 세션 정보와 함께 단계까지 되돌려 놓으므로, 떠 둔 화면 상태는 그 뒤에 얹는다.
          applyChatSurface(previousSurface);
          restored = true;
        } catch {
          // The previous runtime remains discoverable in the live-chat tabs.
        }
      } else if (previousInfo && previous) {
        connectionRef.current = previous;
        applySessionInfo(previousInfo);
        applyChatSurface(previousSurface);
        restored = true;
      }
      if (!restored) {
        sessionRef.current = null;
        setSession(null);
      }
      setError(`${restored ? "이전 채팅은 유지했지만 " : ""}채팅으로 전환하지 못했습니다: ${errorText(cause)}`);
      return false;
    } finally {
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      void refreshLiveChats();
    }
  }, [applyChatSurface, applySessionInfo, captureChatSurface, handleEvent, rememberChatLocalState, refreshLiveChats]);

  /**
   * 전환 요청을 순서대로 처리한다. 진행 중인 전환을 그냥 버리면 그 attach 결과를 받을
   * 주인이 없어(세대 검사에서 이벤트가 전부 버려져) 세션 정보만 있고 대화는 빈 화면으로
   * 남는다. 알림으로 이 화면을 처음 열 때(StrictMode의 이중 마운트·개발 HMR 재마운트)가
   * 그 경우였다.
   */
  const switchChat = useCallback((chatId: string): Promise<boolean> => {
    const pending = chatSwitchQueueRef.current.then(() => runChatSwitch(chatId));
    chatSwitchQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, [runChatSwitch]);

  useEffect(() => {
    if (!attentionTarget) return undefined;
    let cancelled = false;
    void switchChat(attentionTarget.chatId).then((opened) => {
      if (!cancelled) onAttentionTargetHandled(attentionTarget, opened);
    });
    return () => { cancelled = true; };
  }, [attentionTarget, onAttentionTargetHandled, switchChat]);

  const selectedProject = projects.find((project) => project.path === cwd) ?? null;
  const usingManualCwd = manualCwd || !selectedProject;
  const providerModels = models.filter((option) => option.source === source);
  const reasoningOptions = reasoningOptionsFor(providerOptions, model);

  useEffect(() => {
    // 카탈로그 로딩 중(options 비어 있음)에는 복원한 값을 지우지 않는다.
    if (reasoningEffort && reasoningOptions.length > 0 && !reasoningOptions.some((option) => option.effort === reasoningEffort)) {
      setReasoningEffort("");
    }
  }, [reasoningEffort, reasoningOptions]);

  const addInitialFiles = (files: File[]) => {
    setInitialAttachments((current) => {
      const result = appendAttachmentDrafts(current, files);
      setAttachmentNotice(result.error);
      return result.drafts;
    });
  };

  const addComposerFiles = (files: File[]) => {
    setComposerAttachments((current) => {
      const result = appendAttachmentDrafts(current, files);
      setAttachmentNotice(result.error);
      composerAttachmentsRef.current = result.drafts;
      return result.drafts;
    });
  };

  const removeComposerAttachment = (draft: ChatAttachmentDraft) => {
    const next = composerAttachmentsRef.current.filter((item) => item.key !== draft.key);
    composerAttachmentsRef.current = next;
    setComposerAttachments(next);
    releaseAttachmentDraftUpload(draft, sessionRef.current?.chatId);
  };

  /**
   * 아직 만들지 않은 폴더를 작업 경로로 적고 시작하는 것은 흔한 첫 동작이다. 없는 경로일
   * 때만 만들지 물어보고, 승인하면 그 한 칸을 만든 뒤 같은 시작을 한 번 더 시도한다.
   * 실패가 이 종류가 아니거나 사용자가 거절하면 원래 실패를 그대로 올려 보낸다.
   */
  const connectWithMissingDirectoryOffer = async (
    request: Parameters<typeof connectChat>[0],
    onEvent: Parameters<typeof connectChat>[1],
  ) => {
    try {
      return await connectChat(request, onEvent);
    } catch (cause) {
      const missing = missingDirectoryPath(errorText(cause));
      if (!missing || !window.confirm(missingDirectoryPrompt(missing))) throw cause;
      const created = await createDirectory(missing);
      setCwd(created.path);
      return await connectChat({ ...request, cwd: created.path }, onEvent);
    }
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!cwd.trim() || starting) return;
    setStarting(true);
    setError(null);
    turnsRef.current = [];
    setTurns([]);
    phaseRef.current = "connecting";
    setPhase("connecting");
    try {
      const generation = bumpConnectionGeneration();
      const connection = await connectWithMissingDirectoryOffer(
        { source, accountId: launchAccountId || null, cwd: cwd.trim(), model: model.trim() || null, reasoningEffort: reasoningEffort || null, mode, approvalMode, resumeSessionId: null, unattended: false, settings: extraSettings },
        eventsForGeneration(generation),
      );
      connectionRef.current = connection;
      applyAttachSnapshot(connection.info, generation);
      saveChatLaunchSettings(source, { model: model.trim(), reasoningEffort });
      if (connection.info.providerSessionId) {
        void onSessionCatalogChanged(connection.info.source, connection.info.providerSessionId);
      }
      const first = initialPrompt.trim();
      if (first || initialAttachments.length > 0) {
        composerRef.current = first;
        composerAttachmentsRef.current = initialAttachments;
        setComposer(first);
        setComposerAttachments(initialAttachments);
        setInitialPrompt("");
        setInitialAttachments([]);
        setUploadingAttachments(true);
        const uploaded = await uploadAttachmentDrafts(connection.info.chatId, initialAttachments, (next) => {
          composerAttachmentsRef.current = next;
          setComposerAttachments(next);
        });
        await connection.send(first, { attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []) });
        composerRef.current = "";
        composerAttachmentsRef.current = [];
        setComposer("");
        setComposerAttachments([]);
      }
    } catch (cause) {
      if (connectionRef.current) {
        setError(`채팅은 시작했지만 첫 메시지를 보내지 못했습니다: ${errorText(cause)}`);
      } else {
        sessionRef.current = null;
        setSession(null);
        setError(errorText(cause));
      }
    } finally {
      setUploadingAttachments(false);
      setStarting(false);
      void refreshLiveChats();
    }
  };

  const chatBusy = phase === "running" || phase === "waitingApproval";
  const composerUsable = phase === "ready" || chatBusy;
  /**
   * CLI 프로세스가 스스로 끝난(또는 실패한) 채팅은 목록에 남지만 메시지를 받지 못한다.
   * 공급자 세션 ID를 알고 있으면 세션 화면에서 하던 이어가기를 이 자리에서 그대로 할 수 있다.
   */
  const canResumeChat = Boolean(session?.providerSessionId) && (phase === "stopped" || phase === "failed") && !chatSwitching && !resuming;
  const pendingApprovals = turns.flatMap((turn) => turn.entries).filter((entry): entry is Extract<ChatEntry, { type: "approval" }> => entry.type === "approval" && entry.interactive && !entry.resolved);
  /**
   * 지금 답을 기다리는 계획 검토. 계획은 아직 아무것도 실행하지 않은 상태라, 이 자리에서만
   * 실행 중에도 에이전트·실행 계정을 바꿀 수 있다. 바꾸면 이 실행은 승인 없이 접히고
   * 계획이 새 실행으로 넘어간다.
   */
  const pendingPlanApproval = pendingApprovals.find((entry) => entry.kind === "plan") ?? null;

  /**
   * 종료된 채팅을 같은 공급자 대화로 다시 띄운다. 새 런타임이라 chatId는 바뀌지만
   * 화면의 대화는 그대로 두고(원문 합치기가 라이브 구간을 잘라 준다) 연결만 갈아 끼운다.
   */
  const resumeChat = async (): Promise<ChatConnection | null> => {
    const current = sessionRef.current;
    if (!current || resumingRef.current || chatSwitchingRef.current) return null;
    const providerSessionId = current.providerSessionId;
    if (!providerSessionId) {
      setError("공급자 세션이 기록되기 전에 종료된 채팅이라 이어갈 수 없습니다. 새 채팅을 시작하세요.");
      return null;
    }
    resumingRef.current = true;
    setResuming(true);
    setError(null);
    const previous = connectionRef.current;
    const previousPhase = phaseRef.current;
    phaseRef.current = "connecting";
    setPhase("connecting");
    const generation = bumpConnectionGeneration();
    connectionRef.current = null;
    await detachQuietly(previous);
    const adoptConnection = (nextConnection: ChatConnection) => {
      connectionRef.current = nextConnection;
      // 이전 chatId로 남은 초안·스크롤 기억은 다시 열릴 일이 없는 런타임의 것이다.
      forgetChatLocalState(current.chatId);
      setQueue([]);
      queueRef.current = [];
      applyAttachSnapshot(nextConnection.info, generation);
      return nextConnection;
    };
    try {
      // 알림·다른 화면이 같은 공급자 세션의 새 런타임에 이미 붙어 있을 수 있다.
      // resume을 보내기 전에 현재 관리 실행을 찾아 그쪽에 attach하면 active writer
      // 충돌 자체를 만들지 않는다.
      const activeRuntime = await getDetachedChatForSession(current.source, providerSessionId)
        .catch(() => null);
      if (activeRuntime && activeRuntime.chatId !== current.chatId) {
        const existingConnection = await attachChat(activeRuntime.chatId, eventsForGeneration(generation));
        return adoptConnection(existingConnection);
      }
      const nextConnection = await connectChat({
        source: current.source,
        cwd: current.cwd,
        model: model.trim() || null,
        reasoningEffort: reasoningEffort || null,
        mode,
        approvalMode,
        resumeSessionId: providerSessionId,
        unattended: false,
        settings: extraSettings,
      }, eventsForGeneration(generation));
      return adoptConnection(nextConnection);
    } catch (cause) {
      if (cause instanceof ChatRejectedError
        && cause.code === "sessionBusy"
        && cause.existingChatId) {
        try {
          const existingConnection = await attachChat(cause.existingChatId, eventsForGeneration(generation));
          setError(null);
          return adoptConnection(existingConnection);
        } catch (attachCause) {
          phaseRef.current = previousPhase;
          setPhase(previousPhase);
          setError(`기존 세션 실행에 연결하지 못했습니다: ${errorText(attachCause)}`);
          return null;
        }
      }
      // 떼어낸 연결을 되돌려 놓아 봐야 이미 끊긴 구독이다. 상태만 종료된 그대로 돌려놓고
      // 다시 시도할 수 있게 둔다(이어가기는 연결이 아니라 세션 ID로 한다).
      phaseRef.current = previousPhase;
      setPhase(previousPhase);
      setError(`대화를 이어가지 못했습니다: ${errorText(cause)}`);
      return null;
    } finally {
      resumingRef.current = false;
      setResuming(false);
      void refreshLiveChats();
    }
  };

  /** deliverNow면 응답 중에도 중단 없이 진행 중인 작업에 바로 전달한다. */
  const deliverComposer = async (deliverNow: boolean) => {
    const draftText = composer.trim();
    const drafts = composerAttachmentsRef.current;
    if ((!draftText && drafts.length === 0) || uploadingAttachments) return;
    // 종료된 채팅이면 먼저 이어간 뒤 그 런타임으로 보낸다.
    const connection = canResumeChat ? await resumeChat() : connectionRef.current;
    // 쓴 글이 있는데 보낼 길이 없으면 이유를 남긴다. 조용히 돌아가면 사용자에게는
    // 버튼이 먹지 않는 것과 구분되지 않는다(이어가기 실패는 resumeChat이 남긴다).
    if (!connection) {
      if (!canResumeChat) setError("이 채팅에 연결되어 있지 않아 메시지를 보내지 못했습니다. 채팅 목록에서 이 채팅을 다시 열어 주세요.");
      return;
    }
    if (!canResumeChat && !composerUsable) {
      setError(`지금은 메시지를 보낼 수 없는 상태입니다(${phaseLabel(phase, text)}). 잠시 뒤 다시 시도하세요.`);
      return;
    }
    setError(null);
    setUploadingAttachments(true);
    try {
      const uploaded = await uploadAttachmentDrafts(connection.info.chatId, drafts, (next) => {
        composerAttachmentsRef.current = next;
        setComposerAttachments(next);
      });
      // 에이전트를 바꿔 만든 새 세션의 첫 전송에만 인계 문맥을 앞에 싣는다.
      const handoff = pendingHandoffRef.current;
      pendingHandoffRef.current = null;
      const outgoing = handoff
        ? buildSessionHandoffMessage({
          source: handoff.source,
          sessionId: handoff.id,
          transcript: handoff.transcript,
          request: draftText,
        })
        : draftText;
      await connection.send(outgoing, {
        steer: deliverNow,
        attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []),
      });
      composerRef.current = "";
      composerAttachmentsRef.current = [];
      setComposer("");
      setComposerAttachments([]);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUploadingAttachments(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    await deliverComposer(false);
  };

  const runConnectionAction = async (action: (connection: ChatConnection) => Promise<unknown>) => {
    setError(null);
    const connection = connectionRef.current;
    if (!connection) return;
    try {
      await action(connection);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const removeQueued = async (messageId: string) => {
    await runConnectionAction((connection) => connection.removeQueued(messageId));
  };

  const recallQueued = async (message: QueuedChatMessage) => {
    setError(null);
    try {
      await connectionRef.current?.removeQueued(message.id);
      setComposer((current) => {
        const next = current.trim() ? `${current}\n${message.text}` : message.text;
        composerRef.current = next;
        return next;
      });
      const attachments = [...composerAttachmentsRef.current, ...queuedAttachmentsToDrafts(message.attachments, connectionRef.current?.info.chatId ?? null)];
      composerAttachmentsRef.current = attachments;
      setComposerAttachments(attachments);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const decide = async (approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>) => {
    await runConnectionAction((connection) => connection.approve(approvalId, decision, answers));
  };

  const interrupt = async () => {
    await runConnectionAction((connection) => connection.interrupt());
  };

  interface ActiveChatSettings {
    mode: ChatMode;
    approvalMode: ChatApprovalMode;
    model: string;
    reasoningEffort: ReasoningEffort | "";
    extraSettings: Record<string, string>;
    /**
     * 이 실행이 쓸 계정. 빈 값은 "이어가기 설정이 정하는 계정"이다.
     *
     * 재연결에 이 값을 싣지 않으면 백엔드가 고정·이어가기 정책을 거쳐 활성 계정까지
     * 내려가므로, 모델만 바꿔도 채팅이 조용히 다른 계정으로 옮겨 갈 수 있다. 지금
     * 붙어 있는 계정을 그대로 실어 보내 그 이동을 막는다.
     */
    accountId: string;
  }

  const changeActiveChatSettings = async (next: Partial<ActiveChatSettings>, label: string) => {
    if (!session || phase === "connecting" || chatBusy || settingsChangeRef.current) return;
    const current: ActiveChatSettings = {
      mode,
      approvalMode,
      model,
      reasoningEffort,
      extraSettings,
      accountId: session.accountId ?? "",
    };
    const target: ActiveChatSettings = { ...current, ...next };
    if (target.mode === current.mode
      && target.approvalMode === current.approvalMode
      && target.model === current.model
      && target.reasoningEffort === current.reasoningEffort
      && target.accountId === current.accountId
      && sameChatSettings(target.extraSettings, current.extraSettings)) return;
    if (!session.providerSessionId && turns.length > 0) {
      setError(`${label} 변경하려면 공급자 세션 연결이 완료되어야 합니다.`);
      return;
    }

    const previous: ActiveChatSettings = current;
    const previousPhase = phase;
    const connection = connectionRef.current;
    const apply = (settings: ActiveChatSettings) => {
      setMode(settings.mode);
      setApprovalMode(settings.approvalMode);
      setModel(settings.model);
      setReasoningEffort(settings.reasoningEffort);
      setExtraSettings(settings.extraSettings);
    };

    settingsChangeRef.current = true;
    apply(target);
    setError(null);
    setPhase("connecting");
    if (connection) {
      try {
        await connection.stop();
      } catch (cause) {
        apply(previous);
        setPhase(previousPhase);
        setError(`${label} 변경하지 못했습니다: ${errorText(cause)}`);
        settingsChangeRef.current = false;
        return;
      }
    }

    const generation = await retireConnection(connection);
    setQueue([]);
    setPhase("connecting");
    try {
      const nextConnection = await connectChat({
        source: session.source,
        accountId: target.accountId || null,
        cwd: session.cwd,
        model: target.model.trim() || null,
        reasoningEffort: target.reasoningEffort || null,
        mode: target.mode,
        approvalMode: target.approvalMode,
        resumeSessionId: session.providerSessionId,
        unattended: false,
        settings: target.extraSettings,
      }, eventsForGeneration(generation));
      connectionRef.current = nextConnection;
      applyAttachSnapshot(nextConnection.info, generation);
      saveChatLaunchSettings(session.source, {
        model: target.model.trim(),
        reasoningEffort: target.reasoningEffort,
      });
    } catch (cause) {
      setPhase("stopped");
      setError(`${label} 변경 후 채팅에 다시 연결하지 못했습니다: ${errorText(cause)}`);
    }
    settingsChangeRef.current = false;
  };

  /**
   * 이 채팅을 다른 에이전트로 넘긴다.
   *
   * 공급자가 다르면 세션 ID를 공유할 수 없어 재개가 성립하지 않는다. 계정 변경과 달리
   * 새 세션을 만들고, 지금까지의 대화는 다음 전송에 인계 문맥으로 실어 보낸다. 고른
   * 즉시 보내지 않는 것은 에이전트를 바꾼 것이 곧 "지금 작업을 시작하라"는 뜻은 아니기
   * 때문이다. 원본 세션은 그대로 남는다.
   */
  const changeActiveChatAgent = async (nextSource: ProviderId) => {
    if (!session || settingsChangeRef.current || nextSource === session.source) return;
    const plan = pendingPlanApproval;
    if (!plan && (phase === "connecting" || chatBusy)) return;
    const originSessionId = requireProviderSessionId("에이전트를");
    if (!originSessionId) return;
    await confirmAndRestart(plan, {
      title: "에이전트를 바꿀까요?",
      message: plan
        ? planHandoffMessage(`${providerLabel(nextSource)}의 새 세션을 만들어 이 계획을 넘깁니다.`, planModeNotice(mode))
        : `${providerLabel(nextSource)}의 새 세션을 만들고 지금까지의 대화를 인계합니다.\n원본 ${providerLabel(session.source)} 세션은 변경하지 않고 그대로 남습니다.`,
      confirmLabel: plan ? PLAN_RESTART_CONFIRM_LABEL : "새 세션으로 인계",
    }, {
      source: nextSource,
      accountId: null,
      handoff: { source: session.source, id: originSessionId },
      mode: plan ? planRestartMode(mode) : mode,
    });
  };

  /**
   * 실행 계정을 바꾼다. 자격증명은 CLI 프로세스가 뜰 때 정해지므로 살아 있는 실행의
   * 계정은 바꿀 수 없고, 접었다가 같은 세션을 재개해야 한다. 세션 저장소는 계정끼리
   * 공유하므로 재개하면 대화가 그대로 이어진다.
   */
  const changeActiveChatAccount = async (nextAccountId: string) => {
    if (!session || settingsChangeRef.current) return;
    const plan = pendingPlanApproval;
    if (!plan) {
      await changeActiveChatSettings({ accountId: nextAccountId }, "실행 계정을");
      return;
    }
    if ((session.accountId ?? "") === nextAccountId) return;
    if (!requireProviderSessionId("실행 계정을")) return;
    await confirmAndRestart(plan, {
      title: "실행 계정을 바꿀까요?",
      message: planHandoffMessage("같은 대화를 선택한 계정으로 다시 열어 이 계획을 넘깁니다.", planModeNotice(mode)),
      confirmLabel: PLAN_RESTART_CONFIRM_LABEL,
    }, {
      source: session.source,
      accountId: nextAccountId || null,
      handoff: null,
      mode: planRestartMode(mode),
    });
  };

  /**
   * 요청 모드를 바꾼다.
   *
   * 평소에는 같은 세션을 새 권한 범위로 다시 연결하면 끝이다. 계획 승인 중이라면 그
   * 사이에 답을 기다리는 계획이 있는데, 살아 있는 실행에 권한을 더 얹는 길은 승인 응답에
   * 실어 보내는 편집 자동 승인 하나뿐이다(승인 카드의 '계획대로 실행 + 편집 자동 승인'이
   * 그것이다). 그보다 넓은 권한으로 이 계획을 실행하려면 접고 다시 띄우는 수밖에 없어,
   * 에이전트·실행 계정 변경과 같은 길을 지나며 계획 본문을 새 실행의 첫 요청으로 넘긴다.
   */
  const changeActiveChatMode = async (nextMode: ChatMode) => {
    if (!session || settingsChangeRef.current) return;
    const plan = pendingPlanApproval;
    if (!plan) {
      await changeActiveChatSettings({ mode: nextMode }, "요청 모드를");
      return;
    }
    // 계획 모드로 되돌리는 것은 "계획을 다시 세우라"는 뜻이고, 그건 승인 카드의 '계획 다시
    // 세우기'가 할 일이다. 계획을 넘겨받을 실행을 읽기 전용으로 띄우지는 않는다.
    if (nextMode === mode || nextMode === "plan") return;
    if (!requireProviderSessionId("요청 모드를")) return;
    // 요청 모드는 여기서 직접 정하므로 `planModeNotice`가 알릴 것이 없다.
    await confirmAndRestart(plan, {
      title: "요청 모드를 바꿀까요?",
      message: planHandoffMessage(`같은 대화를 ${permissionModeLabel(nextMode)}로 다시 열어 이 계획을 넘깁니다.`),
      confirmLabel: PLAN_RESTART_CONFIRM_LABEL,
    }, {
      source: session.source,
      accountId: session.accountId ?? null,
      handoff: null,
      mode: nextMode,
    });
  };

  /**
   * 다시 띄울 대상이 되는 공급자 세션 ID를 확인한다. 살아 있는 세션 ID가 없으면 재개할
   * 것이 없어 세 갈래가 모두 같은 문장으로 막힌다.
   */
  const requireProviderSessionId = (label: string): string | null => {
    const providerSessionId = session?.providerSessionId ?? null;
    if (!providerSessionId) setError(`${label} 바꾸려면 공급자 세션 연결이 완료되어야 합니다.`);
    return providerSessionId;
  };

  /**
   * 확인을 받고 지금 실행을 접은 뒤 다시 띄운다. 에이전트·실행 계정·요청 모드 세 갈래는
   * 확인 문구와 다시 띄울 대상만 다를 뿐 같은 순서를 지나므로 — 확인, 계획 포기,
   * 재시작 — 그 순서는 여기 한 곳에만 둔다.
   */
  const confirmAndRestart = async (
    plan: Extract<ChatEntry, { type: "approval" }> | null,
    prompt: { title: string; message: string; confirmLabel: string },
    target: {
      source: ProviderId;
      accountId: string | null;
      handoff: { source: ProviderId; id: string } | null;
      mode: ChatMode;
    },
  ) => {
    const accepted = await confirm(prompt);
    if (!accepted) return;
    const firstMessage = await abandonPlanForRestart(plan);
    await restartChatAs({ ...target, firstMessage });
  };

  /**
   * 계획을 승인하지 않고 이 실행을 접을 준비를 한다. 답을 기다리는 CLI를 그대로 죽이면
   * 제어 요청이 미결로 남으므로 취소로 닫고, 새 실행에 넘길 요청 문장을 만들어 준다.
   * 승인 뒤에 접으면 CLI가 이미 편집을 시작한 뒤라 파일이 반쯤 쓰인 채 끊길 수 있어,
   * 이 경로는 언제나 승인 전에 닫는다.
   */
  const abandonPlanForRestart = async (
    plan: Extract<ChatEntry, { type: "approval" }> | null,
  ): Promise<string | undefined> => {
    if (!plan) return undefined;
    await decide(plan.id, "cancel");
    return planExecutionRequest(plan.detail ?? "", session?.source ?? source);
  };

  /** 계획을 넘기며 읽기 전용을 벗어난다면 확인 창에서 그 사실도 함께 말한다. */
  const planModeNotice = (currentMode: ChatMode): string =>
    currentMode === "plan"
      ? `\n요청 모드는 계획을 실행할 수 있도록 ${permissionModeLabel("workspace")}로 바뀝니다.`
      : "";

  /**
   * 지금 실행을 접고 다른 에이전트·계정으로 다시 띄운다.
   *
   * `handoff`가 있으면 공급자가 달라 세션 ID를 쓸 수 없다는 뜻이라 새 세션을 만들고
   * 지금까지의 대화를 인계 문맥으로 넘긴다. 없으면 같은 공급자이므로 같은 세션을
   * 재개한다 — 자격증명은 프로세스가 뜰 때 정해지므로 계정만 바꾸려 해도 이 길을 지난다.
   *
   * `firstMessage`를 주면 새 실행에 그 자리에서 보내고, 없으면 인계 문맥을 다음 전송까지
   * 들고 있는다.
   */
  const restartChatAs = async ({ source: nextSource, accountId, handoff, mode: nextMode, firstMessage }: {
    source: ProviderId;
    accountId: string | null;
    handoff: { source: ProviderId; id: string } | null;
    mode: ChatMode;
    firstMessage?: string;
  }) => {
    const current = sessionRef.current ?? session;
    if (!current) return;
    const previousPhase = phase;
    const connection = connectionRef.current;
    settingsChangeRef.current = true;
    setError(null);
    setPhase("connecting");
    if (connection) {
      try {
        await connection.stop();
      } catch (cause) {
        setPhase(previousPhase);
        setError(`현재 실행을 종료하지 못했습니다: ${errorText(cause)}`);
        settingsChangeRef.current = false;
        return;
      }
    }
    const generation = await retireConnection(connection);
    setQueue([]);
    // 인계는 새 세션이라 이전 실행의 화면 기록을 이어받지 않는다. 같은 세션 재개는
    // 그대로 두어야 대화가 끊겨 보이지 않는다.
    if (handoff) {
      turnsRef.current = [];
      setTurns([]);
    }
    try {
      const nextConnection = await connectChat({
        source: nextSource,
        accountId,
        cwd: current.cwd,
        model: handoff ? null : model.trim() || null,
        reasoningEffort: handoff ? null : reasoningEffort || null,
        mode: nextMode,
        approvalMode: handoff ? defaultApprovalMode(nextSource) : approvalMode,
        resumeSessionId: handoff ? null : current.providerSessionId,
        handoffOrigin: handoff,
        unattended: false,
        settings: handoff ? {} : extraSettings,
      }, eventsForGeneration(generation));
      connectionRef.current = nextConnection;
      applyAttachSnapshot(nextConnection.info, generation);
      if (handoff) {
        const context = { source: handoff.source, id: handoff.id, transcript: transcript.detail?.transcript ?? [] };
        if (firstMessage === undefined) {
          pendingHandoffRef.current = context;
        } else {
          await nextConnection.send(buildSessionHandoffMessage({
            source: context.source,
            sessionId: context.id,
            transcript: context.transcript,
            request: firstMessage,
          }));
        }
      } else if (firstMessage !== undefined) {
        await nextConnection.send(firstMessage);
      }
    } catch (cause) {
      setPhase("stopped");
      setError(handoff
        ? `인계할 새 세션을 시작하지 못했습니다: ${errorText(cause)}`
        : `대화를 다시 연결하지 못했습니다: ${errorText(cause)}`);
    }
    settingsChangeRef.current = false;
    void refreshLiveChats();
  };

  const newChat = async () => {
    if (chatSwitchingRef.current) return;
    chatSwitchingRef.current = true;
    setChatSwitching(true);
    try {
      const connection = connectionRef.current;
      if (connection) {
        const current = sessionRef.current ?? connection.info;
        rememberChatLocalState(current.chatId);
        await connection.detach();
      }
      bumpConnectionGeneration();
      connectionRef.current = null;
      sessionRef.current = null;
      setSession(null);
      applyChatSurface(connectingChatSurface());
      setError(null);
      // 실행 계정은 채팅 하나에만 적용하는 선택이다. 새 채팅은 기본값(활성 계정)에서 시작한다.
      setLaunchAccountId("");
      // 넘기려던 대화도 이 채팅과 함께 두고 간다.
      pendingHandoffRef.current = null;
      void refreshProviderOptions(source).catch((cause) => {
        setError(`최신 실행 설정을 불러오지 못했습니다: ${errorText(cause)}`);
      });
    } catch (cause) {
      setError(`현재 채팅을 백그라운드로 보내지 못했습니다: ${errorText(cause)}`);
    } finally {
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      void refreshLiveChats();
    }
  };

  /**
   * 채팅을 별도 창으로 연다. 백엔드가 화면마다 구독을 따로 유지하므로 이 창의 대화는
   * 그대로 두고 새 창이 같은 대화를 함께 본다. 브라우저 팝업 차단을 피하려면 창 열기가
   * 클릭과 같은 처리 흐름에 있어야 해서 await 없이 바로 호출한다.
   */
  const popOutChat = (chatId: string) => {
    void openPopoutWindow({ kind: "chat", chatId })
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  /**
   * 채팅 실행 종료 확인을 받는다. 현재 채팅과 배경 채팅은 안내 문구만 다르고 제목·버튼·
   * '다음부터 표시 안 함' 처리가 같으므로, 확인을 꺼 둔 사용자를 묻지 않고 통과시키는
   * 판단까지 여기 둔다.
   */
  const confirmChatClose = async (message: string): Promise<boolean> => {
    if (!shouldConfirmChatClose()) return true;
    return confirm({
      title: "채팅 실행을 종료할까요?",
      message,
      confirmLabel: "종료",
      tone: "danger",
      checkbox: {
        label: "다음부터 표시 안 함",
        onConfirm: (checked) => { if (checked) hideChatCloseConfirmation(); },
      },
    });
  };

  const stopCurrentChat = async () => {
    const connection = connectionRef.current;
    const current = sessionRef.current;
    if (!connection || !current || chatSwitchingRef.current) return;
    const active = phaseRef.current === "running" || phaseRef.current === "waitingApproval";
    const accepted = await confirmChatClose(active
      ? "현재 진행 중인 작업과 대기열도 함께 종료됩니다.\n종료한 실행은 채팅 목록에서 제거됩니다."
      : "현재 채팅 실행을 종료합니다.\n종료한 실행은 채팅 목록에서 제거됩니다.");
    if (!accepted) return;

    const nextChatId = openChats.find((chat) => chat.chatId !== current.chatId)?.chatId ?? null;
    chatSwitchingRef.current = true;
    setChatSwitching(true);
    setError(null);
    try {
      await connection.stop();
    } catch (cause) {
      setError(`채팅 실행을 종료하지 못했습니다: ${errorText(cause)}`);
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      return;
    }
    await retireConnection(connection);
    setLiveChats((chats) => chats.filter((chat) => chat.chatId !== current.chatId));
    forgetChatLocalState(current.chatId);
    sessionRef.current = null;
    setSession(null);
    applyChatSurface(connectingChatSurface());
    chatSwitchingRef.current = false;
    setChatSwitching(false);
    if (nextChatId) {
      await switchChat(nextChatId);
    } else {
      void refreshLiveChats();
    }
  };

  const stopBackgroundChat = async (chat: ChatSessionInfo) => {
    if (chat.chatId === sessionRef.current?.chatId) {
      await stopCurrentChat();
      return;
    }
    if (chatSwitchingRef.current || closingChatIds.has(chat.chatId)) return;
    const active = chat.state === "running" || chat.state === "waitingApproval";
    const accepted = await confirmChatClose(active
      ? "이 채팅에서 진행 중인 작업과 대기열도 함께 종료됩니다.\n종료한 실행은 채팅 목록에서 제거됩니다."
      : "이 채팅 실행을 종료하고 채팅 목록에서 제거합니다.");
    if (!accepted) return;

    // 이 경로는 소켓을 새로 붙여 CLI 프로세스를 끝낼 때까지 몇 초가 걸린다. 그동안
    // chatSwitching으로 목록 전체를 잠그면 다른 채팅으로 옮기지도, 새 채팅을 열지도 못한다.
    // 지우는 행만 목록에서 먼저 빼고, 나머지 목록은 계속 쓸 수 있게 둔다.
    setError(null);
    setClosingChatIds((current) => {
      const next = new Set(current);
      next.add(chat.chatId);
      return next;
    });
    let backgroundConnection: ChatConnection | null = null;
    try {
      backgroundConnection = await attachChat(chat.chatId, () => {});
      await backgroundConnection.stop();
      await detachQuietly(backgroundConnection);
      setLiveChats((chats) => chats.filter((candidate) => candidate.chatId !== chat.chatId));
      forgetChatLocalState(chat.chatId);
    } catch (cause) {
      await detachQuietly(backgroundConnection);
      setError(`채팅을 종료하지 못했습니다: ${errorText(cause)}`);
    } finally {
      // 서버 목록이 이 채팅을 실제로 뺐는지 확인한 뒤에 가림을 푼다. 먼저 풀면 종료 요청
      // 전에 떠난 폴링 응답이 방금 지운 행을 잠깐 되살린다. 실패했다면 행이 다시 보인다.
      try { await refreshLiveChats(); } catch { /* 폴링이 곧 다시 맞춘다. */ }
      setClosingChatIds((current) => {
        const next = new Set(current);
        next.delete(chat.chatId);
        return next;
      });
    }
  };

  const openInCodex = async () => {
    const providerSessionId = session?.providerSessionId;
    if (session?.source !== "codex" || !providerSessionId || openingProviderApp) return;
    setOpeningProviderApp(true);
    setError(null);
    bumpConnectionGeneration();
    const connection = connectionRef.current;
    connectionRef.current = null;
    try {
      if (connection) {
        await stopQuietly(connection);
        await detachQuietly(connection);
      }
      setPhase("stopped");
      setQueue([]);
      await openProviderSessionApp(session.source, providerSessionId);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOpeningProviderApp(false);
    }
  };

  // 잘라낸 결과가 비어도 더 불러올 앞 구간이 남아 있으면 머리말과 '이전 대화 더보기'는 남긴다.
  // 파일에 1,000개가 있고 최신 100개를 라이브가 전부 담당하는 채팅이 그 경우다.
  const transcriptHistory = session && (visibleTranscript.length > 0 || transcript.earlierLoadCount > 0) ? (
    <div className="chat-transcript-history">
      <div className="chat-transcript-history-head">
        <div><strong>이전 대화 내역</strong><small>{transcript.detail?.skippedLines ? `읽지 못한 줄 ${transcript.detail.skippedLines.toLocaleString()}개` : "현재 연결 이전 기록"}</small></div>
        <TranscriptLimitSelect
          label="채팅 대화 표시 범위"
          value={transcriptLimit}
          itemCount={transcript.detail ? visibleTranscript.length : null}
          onChange={onTranscriptLimitChange}
        />
      </div>
      {transcript.error && <ErrorBanner message={transcript.error} />}
      <TranscriptLoadEarlier
        count={transcript.earlierLoadCount}
        loading={transcript.loadingEarlier}
        error={transcript.earlierError}
        onLoad={() => void transcript.loadEarlier()}
      />
      <TranscriptTurns
        items={visibleTranscript}
        mode={tab === "activity" ? "activity" : "conversation"}
        activityFilter={activityFilter}
        source={session.source}
        sessionId={session.providerSessionId}
        onOpenLocalLink={linkedFilePreview.open}
        scrollContainerRef={historyScrollRef}
        windowed={transcriptLimit === "all"}
      />
      {turns.length > 0 && <div className="chat-transcript-boundary"><span>여기부터 현재 연결</span></div>}
    </div>
  ) : null;

  // 팝아웃 창은 이 대화 하나만 담당한다. 보기 전환과 채팅 목록은 본 창의 몫이므로,
  // 창에는 대화 패널만 남겨 창 전체를 쓰게 한다.
  const tabs = popout ? null : (
    <div className="chat-hub-tabs">
      {tab !== "schedules" && !chatListOpen && <button ref={chatListRestoreRef} className="secondary-pane-restore chat-list-restore" type="button" aria-label={text("채팅 목록 보기", "Show chat list")} title={text("채팅 목록 보기", "Show chat list")} aria-expanded={false} onClick={() => setChatListVisibility(true)}><PanelLeftOpen size={15} aria-hidden="true" /><span>{text("채팅", "Chat")}</span></button>}
      {/* tablist는 탭 세 개만 소유한다. 목록 복원·새 채팅 버튼은 같은 줄에 놓이지만 탭이 아니므로
          바깥에 둔다. 이 껍데기는 display: contents라 레이아웃은 그대로 .chat-hub-tabs가 맡는다. */}
      <div className="chat-hub-tablist" role="tablist" aria-label={text("채팅 보기", "Chat views")} style={{ display: "contents" }}>
        <button className={tab === "conversation" ? "active" : ""} type="button" role="tab" aria-selected={tab === "conversation"} data-ui-anchor="chat.tab.conversation" onClick={() => setTab("conversation")}><MessagesSquare size={13} aria-hidden="true" /><span>{text("대화", "Conversation")}</span></button>
        <button className={tab === "activity" ? "active" : ""} type="button" role="tab" aria-selected={tab === "activity"} data-ui-anchor="chat.tab.activity" onClick={() => setTab("activity")}><ScrollText size={13} aria-hidden="true" /><span>{text("작업 로그", "Activity")}</span></button>
        <button className={tab === "schedules" ? "active" : ""} type="button" role="tab" aria-selected={tab === "schedules"} data-ui-anchor="chat.tab.schedules" onClick={() => setTab("schedules")}><CalendarClock size={13} aria-hidden="true" /><span>{text("반복 요청", "Recurring requests")}</span></button>
      </div>
      {/* 채팅 목록이 접혀 있으면 '새 채팅'은 목록 안에만 있어 손이 두 번 가야 한다.
          목록을 항상 드로어로 접어 두는 좁은 화면에서 특히 불편하므로, 접힌 동안은 탭 줄에 새 채팅을 꺼내 둔다. */}
      {tab !== "schedules" && session && !chatListOpen && <button className="chat-new-chat-shortcut" type="button" aria-label={text("새 채팅", "New chat")} title={text("현재 채팅은 백그라운드로 두고 새 채팅을 시작합니다", "Keeps the current chat in the background and starts a new one")} disabled={chatSwitching} onClick={() => { setTab("conversation"); void newChat(); }}>
        <Plus size={15} aria-hidden="true" />
        <span>{text("새 채팅", "New chat")}</span>
      </button>}
    </div>
  );

  const closeChatListOnMobile = () => {
    if (window.matchMedia("(max-width: 760px)").matches) closeChatListAndRestoreFocus();
  };

  const runtimeList = chatListOpen && !popout ? (
    <aside className="chat-runtime-list" id="chat-runtime-list" aria-label={text("열린 채팅 목록", "Open chats")}>
      <header>
        <div><strong>{text("채팅", "Chat")}</strong><span>{openChats.length}</span></div>
        <button ref={chatListCloseRef} className="secondary-pane-toggle" type="button" aria-label={text("채팅 목록 숨기기", "Hide chat list")} title={text("채팅 목록 숨기기", "Hide chat list")} onClick={closeChatListAndRestoreFocus}><PanelLeftClose size={15} /></button>
      </header>
      <div className="chat-runtime-list-items">
        <button className={`chat-runtime-list-new${session ? "" : " active"}`} type="button" aria-current={!session ? "page" : undefined} disabled={chatSwitching} onClick={() => { void newChat().then(closeChatListOnMobile); }}>
          <span><Plus size={15} aria-hidden="true" /></span><strong>{text("새 채팅", "New chat")}</strong>
        </button>
        {openChats.map((chat) => {
          const active = session?.chatId === chat.chatId;
          const title = chatTabTitle(chat, chatCatalogSession(chat, sessions));
          return <div className={`chat-runtime-list-item-shell${active ? " active" : ""}`} key={chat.chatId}>
            <button className="chat-runtime-list-item" type="button" aria-current={active ? "page" : undefined} disabled={chatSwitching} title={`${title} · ${providerLabel(chat.source)} · ${phaseLabel(chat.state, text)}`} onClick={() => { void switchChat(chat.chatId).then((opened) => { if (opened) closeChatListOnMobile(); }); }}>
              <span className={`terminal-status terminal-status-${chat.state}`} />
              <span><strong>{title}</strong><small>{providerLabel(chat.source)} · {phaseLabel(chat.state, text)}</small></span>
            </button>
            {!popout && <button className="chat-runtime-list-popout" type="button" disabled={chatSwitching} aria-label={`${title} 새 창으로 열기`} title="새 창으로 열기" onClick={() => popOutChat(chat.chatId)}><AppWindow size={12} /></button>}
            <button className="chat-runtime-list-close" type="button" disabled={chatSwitching} aria-label={`${title} 실행 종료 및 목록에서 제거`} title="실행 종료 및 목록에서 제거" onClick={() => { void stopBackgroundChat(chat); }}><X size={12} /></button>
          </div>;
        })}
      </div>
    </aside>
  ) : null;

  const runtimeBackdrop = chatListOpen && !popout
    ? <button className="chat-runtime-list-backdrop" type="button" aria-label={text("채팅 목록 닫기", "Close chat list")} onClick={closeChatListAndRestoreFocus} />
    : null;

  // 접어 둔 고급 옵션에 기본값이 아닌 선택이 남아 있으면 펼치지 않아도 보이게 요약한다.
  // 고를 항목이 하나도 없는 공급자에서는 빈 상자만 남으므로 고급 옵션 자체를 그리지 않는다.
  const launchAdvancedSummary = launchExtraFields
    .map((field) => extraSettings[field.key]?.trim() ? `${field.label} ${extraSettings[field.key]}` : null)
    .filter(Boolean).join(" · ") || `${launchExtraFields.map((field) => field.label).join(" · ")} 기본값`;

  if (tab === "schedules") {
    return <div className={`chat-hub${popout ? " popout" : ""}`}>{tabs}<SchedulesPanel providers={available} accounts={accounts} projects={projects} models={models} sessions={sessions} snapshot={scheduler} onRefresh={onRefreshScheduler} onSnapshot={onSchedulerSnapshot} currentSession={session} currentPrompt={composer} onOpenSession={onOpenSession} /></div>;
  }

  if (!session) {
    return (
      <div className={`chat-hub${popout ? " popout" : ""}`}>
        {tabs}
        <section className={`chat-runtime-layout${tab === "conversation" ? " chat-runtime-launch-shell" : ""}${chatListOpen ? " list-open" : " list-hidden"}`}>
          {runtimeList}
          {runtimeBackdrop}
          {tab === "activity" ? <div className="chat-runtime-empty"><EmptyState title="표시할 작업 로그가 없습니다" detail="대화를 시작하면 요청별 추론과 도구 실행이 여기에 모입니다." /></div> : (
            <section className="chat-launch-layout chat-launch-workspace">
              <article className="chat-launch-card">
              <div className="section-heading"><div><h2>새 CLI 채팅</h2><p>설치된 공급자 CLI를 구조화 채팅으로 시작합니다.</p></div></div>
              {visibleUnavailable.length > 0 && <div className="chat-cli-connections" aria-label="CLI 연결 필요">
                {visibleUnavailable.map((provider) => <div className="chat-cli-connection-card" key={provider.provider}>
                  <button className="chat-cli-connection-main" type="button" onClick={() => onConnectCli(provider)}>
                    <SourceBadge source={provider.provider} />
                    <span><strong>{provider.displayName}</strong><small>{provider.history.detected ? "채팅은 탐지됨 · CLI 연결 필요" : "CLI 연결 필요"}</small></span>
                    <em>연결</em>
                  </button>
                  <div className="chat-cli-connection-dismiss">
                    <label>
                      <input
                        type="checkbox"
                        checked={rememberHiddenCliConnectionCards.includes(provider.provider)}
                        onChange={(event) => setRememberHiddenCliConnectionCards((current) => event.target.checked
                          ? [...current, provider.provider]
                          : current.filter((item) => item !== provider.provider))}
                      />
                      <span>다시 표시 안 함</span>
                    </label>
                    <button className="chat-cli-connection-close" type="button" aria-label={`${provider.displayName} 연결 카드 닫기`} title="닫기" onClick={() => closeCliConnectionCard(provider.provider)}><X size={14} /></button>
                  </div>
                </div>)}
              </div>}
              {available.length === 0 ? <EmptyState title="연결 가능한 CLI가 없습니다" detail="위 공급자를 선택하면 설치·로그인용 터미널 가이드가 열립니다." /> : (
                <form className="chat-launch-form" onSubmit={start}>
                  <label><span>공급자</span><select value={source} onChange={(event) => switchSource(event.target.value as ProviderId)}>{available.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.displayName}</option>)}</select></label>
                  <label>
                    <span>작업 경로</span>
                    {projects.length > 0 && <select value={usingManualCwd ? MANUAL_CWD : cwd} onChange={(event) => { const value = event.target.value; setManualCwd(value === MANUAL_CWD); if (value !== MANUAL_CWD) setCwd(value); }}>{projects.map((project) => <option value={project.path} key={project.path}>{project.name} · {project.path}</option>)}<option value={MANUAL_CWD}>직접 입력…</option></select>}
                    {usingManualCwd ? <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/project/path" required autoFocus={manualCwd} /> : <small className="chat-path-hint">{selectedProject?.path} · 세션 {selectedProject?.count}개</small>}
                  </label>
                  {accountChoices.length > 0 && <label>
                    <span>실행 계정</span>
                    <select value={launchAccountId} onChange={(event) => setLaunchAccountId(event.target.value)}>
                      <option value="">활성 계정{launchActiveAccountId ? ` · ${accountName(accounts, source, launchActiveAccountId)}` : ""}</option>
                      {accountChoices.map((choice) => <option value={choice.id} key={choice.id} disabled={choice.blocked} title={choice.blockedReason ?? undefined}>
                        {choice.label}{choice.blocked ? " · 자격증명 격리 불가" : ""}
                      </option>)}
                    </select>
                    {launchAccountId !== "" && <small className="chat-path-hint">이 채팅만 선택한 계정으로 실행합니다. 활성 계정은 그대로 둡니다.</small>}
                  </label>}
                  <RuntimeSettings
                    source={source}
                    mode={mode}
                    onModeChange={setMode}
                    approvalMode={approvalMode}
                    onApprovalModeChange={setApprovalMode}
                    model={model}
                    onModelChange={setModel}
                    catalog={providerOptions}
                    recent={providerModels}
                    reasoningEffort={reasoningEffort}
                    onReasoningChange={setReasoningEffort}
                    reasoningOptions={reasoningOptions}
                    defaultEffort={defaultEffortFor(providerOptions, model)}
                  />
                  {/* 추가 스키마 항목(예비 모델 등)은 아래 고급 옵션의 RuntimeExtraSettings가 맡는다.
                      여기에 onExtraSettingChange를 다시 넘기면 같은 항목이 두 번 그려진다. */}
                  {launchExtraFields.length > 0 && <section className="chat-launch-advanced">
                    <button className="chat-launch-advanced-toggle" type="button" aria-expanded={launchAdvancedOpen} onClick={() => setLaunchAdvancedOpen((open) => !open)}>
                      {launchAdvancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}고급 옵션<small>{launchAdvancedSummary}</small>
                    </button>
                    {launchAdvancedOpen && <div className="chat-launch-advanced-body">
                      <RuntimeExtraSettings source={source} catalog={providerOptions} recent={providerModels} extraSettings={extraSettings} onExtraSettingChange={(key, value) => setExtraSettings((current) => ({ ...current, [key]: value }))} />
                    </div>}
                  </section>}
                  <div className="chat-initial-composer"><label><span>첫 메시지 <small>선택</small></span><textarea value={initialPrompt} onChange={(event) => setInitialPrompt(event.target.value)} onKeyDown={submitComposerOnEnter} onPaste={(event) => { const files = clipboardFiles(event); if (files.length > 0) addInitialFiles(files); }} rows={1} placeholder="CLI 연결 직후 보낼 요청" /></label></div>
                  {error && <ErrorBanner message={error} />}
                  {attachmentNotice && <ErrorBanner message={attachmentNotice} />}
                  <div className="chat-launch-footer"><AttachmentPicker drafts={initialAttachments} disabled={starting} onAdd={addInitialFiles} onRemove={(draft) => setInitialAttachments((current) => current.filter((item) => item.key !== draft.key))} /><button className="button primary chat-start-button" type="submit" disabled={starting || !cwd.trim()}>{starting ? "CLI 연결 중…" : "새 채팅 시작"}</button></div>
                </form>
              )}
              </article>
            </section>
          )}
        </section>
        {confirmDialog}
      </div>
    );
  }

  // 활성 계정이 아닌 계정으로 시작한 채팅만 어느 계정으로 도는지 머리말에 적는다.
  // 활성 계정으로 도는 대부분의 채팅에는 표시가 붙지 않는다.
  // 에이전트 선택지는 시작 화면과 같은 기준이다 — CLI가 연결되지 않은 공급자는 고를 수 없다.
  const runtimeAgentChoices: ChatAgentChoice[] = providers.map((provider) => ({
    source: provider.provider,
    label: provider.displayName,
    disabled: !provider.cli.detected,
    disabledReason: provider.cli.detected ? null : "이 공급자의 CLI가 연결되어 있지 않습니다",
  }));
  const runtimeAccountChoices = launchAccountChoices(accounts, session.source);
  const runningAccountLabel = session.accountId && session.accountId !== activeAccountId(accounts, session.source)
    ? accountName(accounts, session.source, session.accountId)
    : null;

  return (
    <div className={`chat-hub${popout ? " popout" : ""}`}>
      {tabs}
      <section className={`chat-runtime-layout${chatListOpen ? " list-open" : " list-hidden"}`}>
        {runtimeList}
        {runtimeBackdrop}
        <section className="structured-chat">
        <header className="chat-session-header">
          <div><span className={`terminal-status terminal-status-${phase}`} /><div><strong>{providerLabel(session.source)} · {phaseLabel(phase, text)}</strong><small>{session.cwd}{runningAccountLabel ? ` · ${text("계정", "Account")} ${runningAccountLabel}` : ""}</small></div></div>
          <div className="chat-session-actions">
            {(phase === "stopped" || phase === "failed") && session.providerSessionId && <button className="button primary" type="button" disabled={!canResumeChat} onClick={() => void resumeChat()} title={text("같은 공급자 대화를 다시 띄워 이어갑니다", "Reopens the same provider conversation and continues it")}><RotateCw size={13} />{resuming ? text("이어가는 중…", "Resuming…") : text("이어가기", "Resume")}</button>}
            {/* 좁은 화면에서 팝아웃은 같은 탭을 밀어내는 꼴이라 쓸모가 없다. 그 자리를 새 채팅이 대신 쓰고,
                두 버튼은 CSS 미디어쿼리로 갈라 끼운다(뷰포트를 JS로 재느니 화면 폭에 맡긴다). */}
            {!popout && <button className="button chat-session-popout-action" type="button" onClick={() => popOutChat(session.chatId)} title={text("이 채팅을 별도 창으로 엽니다. 이 창의 대화도 그대로 유지됩니다.", "Opens this chat in a separate window. The conversation here stays as is.")}><AppWindow size={13} />{text("새 창으로 열기", "Open in new window")}</button>}
            {!popout && <button className="button chat-session-new-chat-action" type="button" disabled={chatSwitching} onClick={() => { setTab("conversation"); void newChat(); }} title={text("이 채팅은 백그라운드로 두고 새 채팅을 시작합니다", "Keeps this chat in the background and starts a new one")}><Plus size={13} />{text("새 채팅", "New chat")}</button>}
            {hasTauriRuntime() && session.source === "codex" && session.providerSessionId && <button className="button" type="button" disabled={openingProviderApp || phase === "running" || phase === "waitingApproval"} onClick={() => void openInCodex()} title={text("이 연결을 종료하고 같은 대화를 Codex 앱에서 엽니다", "Closes this connection and opens the same conversation in the Codex app")}><ExternalLink size={13} />{openingProviderApp ? text("여는 중…", "Opening…") : text("Codex에서 열기", "Open in Codex")}</button>}
          </div>
        </header>
        <div className="chat-session-meta"><code>{session.providerSessionId ?? session.chatId}</code><span>{session.model ?? text("기본 모델", "Default model")}</span><span>{text("추론", "Reasoning")} {session.reasoningEffort ? reasoningLabel(session.reasoningEffort) : text("기본", "Default")}</span><span>{permissionModeLabel(session.mode)}</span>{settingField(settingFieldsFor(providerOptions, session.source), "approvalMode") && <span>{approvalModeLabel(session.approvalMode)}</span>}</div>
        {error && <div className="chat-inline-error"><ErrorBanner message={error} /></div>}
        {attachmentNotice && <div className="chat-inline-error"><ErrorBanner message={attachmentNotice} /></div>}
        {tab === "activity" ? (
          <ActivityLog containerRef={activityLogRef} history={transcriptHistory} turns={turns} chatId={activeChatId} filter={activityFilter} onFilter={setActivityFilter} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} />
        ) : (
          <div className="chat-stream-shell">
            <div className="chat-stream" aria-live="polite" ref={chatStreamRef}>
              {transcriptHistory}
              {turns.length === 0 && !transcriptHistory && <EmptyState title={text("CLI가 연결되었습니다", "CLI connected")} detail={text("아래 입력창에서 첫 메시지를 보내세요.", "Send your first message from the composer below.")} />}
              {turns.map((turn) => <ChatConversationTurn turn={turn} chatId={activeChatId} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} key={turn.id} />)}
            </div>
            <ChatScrollControls
              targetRef={chatStreamRef}
              onScrollAwayFromLatest={pauseFollowingLatestMessages}
              onScrollToLatest={resumeFollowingLatestMessages}
            />
          </div>
        )}
        <ChatApprovalDock title={text("권한 승인 대기", "Awaiting permission approval")} hint={text("선택할 때까지 에이전트 작업이 일시 정지됩니다.", "The agent pauses until you choose.")} prompts={pendingApprovals} onDecision={decide} />
        <ChatRuntimeSettingsMenu
          panelId="chat-runtime-settings-panel"
          contextLabel={text("채팅", "Chat")}
          source={session.source}
          mode={mode}
          approvalMode={approvalMode}
          model={model}
          modelOptions={providerOptions?.models ?? []}
          recentModels={models.filter((option) => option.source === session.source)}
          reasoningEffort={reasoningEffort}
          reasoningOptions={reasoningOptions}
          settingFields={settingFieldsFor(providerOptions, session.source)}
          extraSettings={extraSettings}
          agentChoices={runtimeAgentChoices}
          accountChoices={runtimeAccountChoices}
          accountId={session.accountId ?? ""}
          locked={phase === "connecting" || chatBusy}
          planRestartLocked={phase === "connecting" || (chatBusy && !pendingPlanApproval)}
          planRestartNote={pendingPlanApproval
            ? text("계획 승인 중입니다. 지금 에이전트·실행 계정·요청 모드를 바꾸면 이 실행은 계획을 승인하지 않고 접히고, 계획이 새 실행으로 넘어갑니다.", "A plan is awaiting approval. Changing the agent, account, or request mode now folds this run without approving the plan and hands the plan to a new run.")
            : undefined}
          statusIndicator={<span className={`terminal-status terminal-status-${phase}`} />}
          contextMeter={<ChatContextMeter usedTokens={session.contextUsedTokens} windowTokens={session.contextWindowTokens} />}
          onOpen={() => {
            void refreshProviderOptions(session.source).catch((cause) => {
              setError(`최신 실행 설정을 불러오지 못했습니다: ${errorText(cause)}`);
            });
          }}
          onAgentChange={(nextSource) => void changeActiveChatAgent(nextSource)}
          onAccountChange={(nextAccountId) => void changeActiveChatAccount(nextAccountId)}
          onModeChange={(nextMode) => void changeActiveChatMode(nextMode)}
          onApprovalModeChange={(nextMode) => void changeActiveChatSettings({ approvalMode: nextMode }, "승인 처리를")}
          onModelChange={(nextModel) => void changeActiveChatSettings({ model: nextModel }, "응답 모델을")}
          onReasoningEffortChange={(nextEffort) => void changeActiveChatSettings({ reasoningEffort: nextEffort }, "추론 수준을")}
          onExtraSettingsApply={(nextSettings) => void changeActiveChatSettings({ extraSettings: nextSettings }, "추가 설정을")}
        />
        <ChatComposer
          ariaLabel={text("채팅 메시지", "Chat message")}
          value={composer}
          attachments={composerAttachments}
          uploading={uploadingAttachments}
          busy={chatBusy}
          canCompose={(composerUsable || canResumeChat) && !uploadingAttachments}
          rows={1}
          placeholder={phase === "ready" ? text("메시지를 입력하거나 파일을 첨부하세요", "Type a message or attach a file")
            : phase === "waitingApproval" ? text("승인 대기 중입니다. 전송하면 대기열에 추가됩니다", "Awaiting approval. Sending adds the message to the queue")
              : chatBusy ? text("응답 중입니다. 전송하면 대기열에 추가됩니다", "Responding. Sending adds the message to the queue")
                : resuming ? text("대화를 이어가는 중입니다", "Resuming the conversation")
                  : canResumeChat ? text("종료된 채팅입니다. 전송하면 이 대화를 이어서 시작합니다", "This chat has stopped. Sending resumes the conversation")
                    : text("채팅이 종료되었습니다. 새 채팅을 시작하세요", "This chat has ended. Start a new chat")}
          queue={queue}
          canDeliver={supportsDeliveryDuringTurn(session.source)}
          onChange={(value) => { composerRef.current = value; setComposer(value); }}
          onAddFiles={addComposerFiles}
          onRemoveAttachment={removeComposerAttachment}
          onSubmit={send}
          onQueue={() => void deliverComposer(false)}
          onDeliver={() => void deliverComposer(true)}
          onInterrupt={() => void interrupt()}
          onRemoveQueued={(messageId) => void removeQueued(messageId)}
          onRecallQueued={(item) => void recallQueued(item)}
        />
        </section>
      </section>
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
      {confirmDialog}
    </div>
  );
}

function ActivityLog({ containerRef, history, turns, chatId, filter, onFilter, onDecision, onOpenLocalLink }: { containerRef: RefObject<HTMLDivElement | null>; history: ReactNode; turns: ChatTurn[]; chatId: string | null; filter: ActivityFilter; onFilter: (filter: ActivityFilter) => void; onDecision: (id: string, decision: ChatApprovalDecision) => void; onOpenLocalLink: (href: string) => void }) {
  return (
    <div className="activity-log" ref={containerRef}>
      <header><strong>요청별 작업 로그</strong><ActivityFilterSelect value={filter} onChange={onFilter} /></header>
      {history}
      {turns.length === 0 ? (history ? null : <EmptyState title="작업 로그가 없습니다" />) : turns.map((turn) => {
        const entries = turn.entries.filter((entry) => activityMatches(entry, filter));
        if (entries.length === 0) return null;
        const userEntry = turn.entries.find((entry): entry is Extract<ChatEntry, { type: "message" }> => entry.type === "message" && entry.role === "user");
        const title = userEntry?.text.slice(0, 80) || userEntry?.attachments[0]?.name || "시스템 작업";
        return <section className="activity-turn" key={turn.id}><header><span className={`chat-tool-state chat-tool-state-${turn.status}`} /><strong>{title}</strong><time>{chatTurnStatusLabel(turn.status)} · {formatDate(turn.startedAt)}</time></header><div>{entries.map((entry) => <ChatEntryView entry={entry} chatId={chatId} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} key={`${entry.type}-${entry.id}`} />)}</div></section>;
      })}
    </div>
  );
}

const CHAT_LAUNCH_SETTINGS_KEY = "agent-manager.chat-launch-settings";

interface ChatLaunchSettings {
  model: string;
  reasoningEffort: ReasoningEffort | "";
}

type StoredChatLaunchSettings = Record<string, Partial<ChatLaunchSettings>> | null;

function readChatLaunchSettings(source: ProviderId): ChatLaunchSettings {
  const entry = readStoredJson<StoredChatLaunchSettings>(CHAT_LAUNCH_SETTINGS_KEY, null)?.[source];
  return {
    model: typeof entry?.model === "string" ? entry.model : "",
    reasoningEffort: typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : "",
  };
}

function saveChatLaunchSettings(source: ProviderId, settings: ChatLaunchSettings) {
  const stored = readStoredJson<StoredChatLaunchSettings>(CHAT_LAUNCH_SETTINGS_KEY, null);
  writeStoredJson(CHAT_LAUNCH_SETTINGS_KEY, { ...stored, [source]: settings });
}

function chatCatalogSession(chat: ChatSessionInfo, sessions: SessionSummary[]): SessionSummary | null {
  return chat.providerSessionId
    ? sessions.find((candidate) => candidate.source === chat.source && candidate.id === chat.providerSessionId) ?? null
    : null;
}

function chatTabTitle(chat: ChatSessionInfo, session: SessionSummary | null): string {
  const parts = chat.cwd.split(/[\\/]/).filter(Boolean);
  const fallback = parts[parts.length - 1] ?? providerLabel(chat.source);
  return session?.title ?? `${fallback} · ${chat.chatId.slice(0, 4)}`;
}

function providerLabel(source: ProviderId): string { return source === "claude" ? "Claude" : source === "codex" ? "Codex" : "Antigravity"; }
type TextPicker = (ko: string, en: string) => string;
function phaseLabel(phase: ChatPhase | "connecting", text: TextPicker): string {
  return phase === "connecting" ? text("연결 중", "Connecting")
    : phase === "ready" ? text("입력 대기", "Ready")
      : phase === "running" ? text("응답 중", "Responding")
        : phase === "waitingApproval" ? text("승인 대기", "Awaiting approval")
          : phase === "stopped" ? text("종료됨", "Stopped")
            : text("오류", "Error");
}
