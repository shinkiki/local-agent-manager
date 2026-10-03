import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, CalendarClock, ExternalLink, GitBranch, MessagesSquare, PanelLeftOpen, Plus, RotateCw, ScrollText } from "lucide-react";
import { attachChat, connectChat, supportsDeliveryDuringTurn, supportsSessionFork, type ChatConnection } from "../lib/chat";
import { ChatRejectedError } from "../lib/chatReconnect";
import type { TabRequest } from "../lib/uiGuide";
import {
  createDirectory,
  getDetachedChatForSession,
  getLiveChats,
  hasTauriRuntime,
  openProviderSessionApp,
  previewDirectoryCreation,
} from "../lib/ipc";
import { sourceName } from "../lib/format";
import { displayPath } from "../lib/displayPath";
import { useI18n } from "../lib/i18n";
import { runtimeText } from "../lib/i18nRuntime";
import { directoryCreationItems, missingDirectoryPath } from "../lib/missingDirectory";
import { useChatTranscriptHistory } from "./ChatTranscriptHistory";
import { useReadingBookmarks } from "./ReadingBookmarks";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatApprovalDecision,
  ChatEvent,
  ChatMode,
  ChatPhase,
  ChatSessionInfo,
  ChatStartRequest,
  MessageDisplayMode,
  ModelOption,
  ProjectOption,
  ProviderId,
  ProviderStatus,
  QueuedChatMessage,
  SchedulerSnapshot,
  SessionMeta,
  SessionSummary,
  SessionTranscriptLimit,
  TranscriptItem,
} from "../types";
import { ChatApprovalDock, ChatContextMeter, ErrorBanner, EmptyState, FileDropOverlay, NoticeBanner, useConfirm, useFileDropZone } from "./Shared";
import { LinkedFilePreview } from "./LinkedFilePreview";
import { useChatLinkedFiles } from "./ChatLinkedFiles";
import { ChatRuntimeList, chatCatalogSession, chatTabTitle, phaseLabel, useChatListPane } from "./ChatRuntimeList";
import { ChatRuntimeSettingsMenu, useCatalogReasoningOptions, type ChatAgentChoice } from "./ChatRuntimeSettingsMenu";
import {
  addAttachmentDrafts,
  queuedAttachmentsToDrafts,
  releaseAttachmentDraftUpload,
  sendWithAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { ChatComposer } from "./ChatComposer";
import { ChatSecretsPanel } from "./ChatSecretsPanel";
import { useChatLocalMemory } from "./ChatLocalMemory";
import {
  detachQuietly,
  runChatConnectionAction,
  shutdownConnection,
} from "./ChatConnectionAction";
import { switchAttachedChat, useSerializedTaskQueue } from "./ChatConnectionGeneration";
import { SchedulesPanel } from "./ChatSchedules";
import {
  applyChatEvent,
  ChatConversationTurn,
  ChatScrollControls,
  lastUserMessageKey,
  pendingChatApprovals,
  scrollToLastUserMessage,
  useFollowLatestMessages,
  type ChatEntry,
  type ChatTurn,
} from "./ChatConversation";
import { ChatActivityLog } from "./ChatActivityLog";
import { FIND_PRIORITY, useChatFind } from "./ChatFindBar";
import { useMirroredState } from "./ChatMirroredState";
import { accountName, activeAccountId, launchAccountChoices, resolveLaunchAccountId } from "../lib/launchAccount";
import { limitedAccountHandoff } from "../lib/limitedAccountHandoff";
import { buildSessionHandoffMessage } from "../lib/sessionHandoff";
import { planExecutionRequest, planRestartMode } from "../lib/planRestart";
import type { ActivityFilter } from "../lib/activityFilter";
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
import { shouldApplyLivePhaseSnapshot } from "../lib/livePhaseSync";
import { usePoll } from "../lib/poll";
import { openPopoutWindow, usePopoutWindowTitle } from "../lib/popoutWindow";
import { refreshProviderOptions, useProviderOptions } from "../lib/providerOptions";
import { saveChatLaunchSettings } from "./ChatLocalSettings";
import { useChatRuntimeDraft, type ChatRuntimeSettings } from "./ChatRuntimeDraft";
import { localConnectionIdForRequest } from "../lib/localConnections";
import { ChatLaunchForm, useCliConnectionCards, useLaunchAdvancedSettings } from "./ChatLaunchPanel";
import { hideChatCloseConfirmation, shouldConfirmChatClose } from "../lib/chatCloseConfirmation";
import { errorText } from "../lib/errorText";
import { saveSessionMetaPatch } from "../lib/sessionMetaSave";

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
  /** 채팅 목록의 즐겨찾기 토글이 바꾼 세션 메타. 목록·대시보드가 같은 스냅샷을 쓴다. */
  onMetaChanged: (source: ProviderId, id: string, meta: SessionMeta) => void;
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

/**
 * 계획을 다른 실행으로 넘기는 확인 창이 공통으로 말하는 것: 지금 실행은 승인 없이 접히고,
 * 그래서 아직 아무것도 실행되지 않았다. 앞머리만 갈래마다 다르다.
 */
function planHandoffMessage(lead: string, notice = ""): string {
  return `${lead}\n${runtimeText("지금 실행은 계획을 승인하지 않고 접히므로 아직 아무것도 실행되지 않습니다.", "The current run is closed without approving the plan, so nothing has been executed yet.")}${notice}`;
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

/** 종료 확인을 띄우는 자리 — 화면에 떠 있는 채팅인지, 목록에만 있는 배경 채팅인지. */
type ChatCloseScope = "current" | "background";

/**
 * 종료 확인에 띄울 안내. 갈래(현재·배경) × 진행 여부로 네 문구가 갈리는데, 호출부마다
 * 삼항으로 적어 두면 "목록에서 제거된다"는 같은 사실을 자리마다 다르게 쓰게 된다.
 *
 * 배경 채팅의 멈춘 갈래만 제거를 한 문장에 붙여 쓰는 것은 그대로 두었다. 화면에 없는
 * 채팅이라 "종료한 실행"이라고 가리킬 대상이 사용자 눈앞에 없기 때문이다.
 */
function chatCloseConfirmMessage(scope: ChatCloseScope, active: boolean): string {
  const removal = runtimeText("종료한 실행은 채팅 목록에서 제거됩니다.", "Closed runs are removed from the chat list.");
  if (active) {
    const subject = scope === "current"
      ? runtimeText("현재 진행 중인 작업과 대기열도", "In-progress work and queued messages will also")
      : runtimeText("이 채팅에서 진행 중인 작업과 대기열도", "In-progress work and queued messages in this chat will also");
    return `${subject} ${runtimeText("함께 종료됩니다.", "be terminated together.")}\n${removal}`;
  }
  return scope === "current"
    ? `${runtimeText("현재 채팅 실행을 종료합니다.", "Closing current chat run.")}\n${removal}`
    : runtimeText("이 채팅 실행을 종료하고 채팅 목록에서 제거합니다.", "Close this chat run and remove it from the chat list.");
}

export function ChatView({ providers, accounts, projects, models, sessions, messageDisplayMode, transcriptLimit, onTranscriptLimitChange, scheduler, onRefreshScheduler, onSchedulerSnapshot, onConnectCli, onOpenSession, onMetaChanged, onSessionCatalogChanged, attentionTarget, onAttentionTargetHandled, tabRequest = null, popout = false }: ChatViewProps) {
  // 정적 치환기는 화면에 그려지는 텍스트 노드만 덮는다. aria-label·title·placeholder처럼
  // 속성으로만 있는 문구는 여기서 text(ko, en)으로 직접 고른다.
  const { text } = useI18n();
  const planRestartConfirmLabel = text("이 계획으로 다시 시작", "Restart with this plan");
  const available = useMemo(() => providers.filter((provider) => provider.cli.detected), [providers]);
  const unavailable = useMemo(() => providers.filter((provider) => !provider.cli.detected), [providers]);
  const { cliConnectionCards } = useCliConnectionCards(unavailable, onConnectCli);
  const initialSource = available[0]?.provider ?? "codex";
  const [tab, setTab] = useState<ChatTab>("conversation");
  const chatListPane = useChatListPane(popout);
  const chatListOpen = chatListPane.open;
  // 대시보드 '반복 일정' 패널에서 넘어온 요청은 반복 요청 탭을 바로 연다.
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  // 시작 폼은 묶음을 통째로 받아 칸을 그린다. 나머지 본문은 낱개 이름으로 읽으므로 둘 다 둔다.
  const runtimeDraft = useChatRuntimeDraft(initialSource, projects[0]?.path ?? "");
  const {
    source,
    launchAccountId,
    setLaunchAccountId,
    cwd,
    setCwd,
    model,
    localConnectionId,
    reasoningEffort,
    setReasoningEffort,
    mode,
    setMode,
    approvalMode,
    setApprovalMode,
    extraSettings,
    setExtraSettings,
    applySettings: applyRuntimeSettings,
    switchSource,
    adoptSessionSettings,
  } = runtimeDraft;
  const [initialPrompt, setInitialPrompt] = useState("");
  const [initialAttachments, setInitialAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [composer, composerRef, putComposerText] = useMirroredState("");
  const [composerAttachments, composerAttachmentsRef, putComposerAttachments] = useMirroredState<ChatAttachmentDraft[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [session, sessionRef, putSession] = useMirroredState<ChatSessionInfo | null>(null);
  const [liveChats, setLiveChats] = useState<ChatSessionInfo[]>([]);
  // 종료를 요청한 배경 채팅. 3초 폴링이 아직 살아 있는 그 채팅을 목록에 되살리지 못하게
  // 화면에서만 걸러 낸다. 실패하면 다시 목록에 나타난다.
  const [closingChatIds, setClosingChatIds] = useState<ReadonlySet<string>>(() => new Set());
  const [phase, phaseRef, putPhase, setPhase] = useMirroredState<ChatPhase | "connecting">("connecting");
  const [queue, queueRef, putQueue, setQueue] = useMirroredState<QueuedChatMessage[]>([]);
  const [turns, turnsRef, putTurns, setTurns] = useMirroredState<ChatTurn[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  // 승인 카드로 비밀값을 맡길 때마다 오르는 수. 비밀값 줄이 목록을 다시 읽을 신호다.
  const [chatSecretSignal, setChatSecretSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * 첨부 거절 안내. 시작·연결 오류(`error`)와 자리를 나눈다 — 한 자리에 실으면 거절 뒤에
   * 정상 첨부를 이어 담아도 안내가 남고, 반대로 첨부를 담을 때 연결 오류를 지워 버린다.
   * 거절이 없는 담기는 이전 거절 안내를 지운다.
   */
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  /**
   * 한도에 걸린 계정에서 지금의 기본 계정으로 이 대화를 옮겨 다시 열었다는 안내. 실패가
   * 아니므로 오류 자리를 쓰지 않는다. 전송할 때마다 새로 판정하므로 다음 전송에서 지운다.
   */
  const [accountHandoffNotice, setAccountHandoffNotice] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [chatSwitching, chatSwitchingRef, markChatSwitching] = useMirroredState(false);
  const [resuming, resumingRef, markResuming] = useMirroredState(false);
  const [openingProviderApp, setOpeningProviderApp] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  /**
   * 실패 안내를 "무엇을 못 했는지: 원인" 한 모양으로 적는다. 열세 자리가 같은 식을 각자
   * 조립하고 있어, 구분 기호나 원인 추출을 한 자리에서만 고치면 같은 종류의 실패가 화면마다
   * 다른 모양으로 보였다. 갈래가 정하는 것은 앞머리뿐이고 붙이는 일은 여기서 한다.
   *
   * 원인을 덧붙이지 않는 안내(상태 때문에 보낼 수 없다 같은 것)는 지금처럼 `setError`를
   * 그대로 쓴다 — 이 손잡이는 "원인이 있는 실패"만 맡는다.
   */
  const reportFailure = (lead: string, cause: unknown) => {
    setError(`${lead}: ${errorText(cause)}`);
  };
  /**
   * 실행 설정 스키마를 다시 조사한다. 새 채팅과 실행설정 메뉴가 각자 같은 호출과 같은
   * 실패 문구를 적고 있었다 — 조사 실패는 어느 쪽에서 눌렀든 같은 일이므로 한 벌로 둔다.
   */
  const loadLatestRuntimeOptions = (target: ProviderId) => {
    void refreshProviderOptions(target).catch((cause: unknown) => {
      reportFailure(text("최신 실행 설정을 불러오지 못했습니다", "Failed to load latest launch settings"), cause);
    });
  };
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
   * 화면이 쥐고 있던 연결을 놓는다. 세대를 먼저 올려 이 연결에서 뒤늦게 도착하는 이벤트를
   * 버리게 한 다음 참조를 비운다 — 순서가 뒤집히면 놓는 도중 들어온 이벤트가 이미 놓은
   * 대화에 다시 붙는다. 놓은 연결과 새로 쓸 세대 번호를 함께 돌려준다.
   *
   * 놓기와 뒷정리(detach·stop·아무것도 안 함)는 갈래마다 다르므로 여기서 하지 않는다.
   */
  const takeConnection = (): { connection: ChatConnection | null; generation: number } => {
    const generation = bumpConnectionGeneration();
    const connection = connectionRef.current;
    connectionRef.current = null;
    return { connection, generation };
  };
  /**
   * 지금 붙어 있는 연결을 화면에서 떼어내고 구독까지 조용히 끊는다. 떼는 순서는
   * `takeConnection`이 지키고, 여기서는 정리할 연결을 호출부가 쥐고 있던 것으로 받는다 —
   * 종료를 기다리는 사이에 다른 갈래가 참조를 갈아끼웠더라도 원래 붙어 있던 것을 끊는다.
   * 새로 쓸 세대 번호를 돌려준다.
   */
  const retireConnection = async (connection: ChatConnection | null): Promise<number> => {
    const { generation } = takeConnection();
    await detachQuietly(connection);
    return generation;
  };
  /**
   * 같은 채팅을 새 실행으로 갈아끼우기 직전까지를 한자리에서 처리한다. 설정 변경과 인계는
   * 갈아끼우는 이유만 다를 뿐 준비 과정이 같다 — 설정 변경 중임을 세우고, 화면을 연결 중으로
   * 돌리고, 지금 실행을 종료하고, 연결을 은퇴시켜 새 세대를 얻고, 옛 실행 앞으로 쌓인 전송
   * 대기열을 비운다.
   *
   * 종료에 실패하면 화면 단계를 되돌리고 `onStopFailed`로 각자의 문구를 알린 뒤 null을
   * 돌려준다. 멈추지 못한 실행 위에 새 연결을 얹으면 같은 세션에 프로세스가 둘 붙는다.
   */
  const beginChatRelaunch = async ({ onStopFailed }: { onStopFailed: (cause: unknown) => void }): Promise<number | null> => {
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
        onStopFailed(cause);
        settingsChangeRef.current = false;
        return null;
      }
    }
    const generation = await retireConnection(connection);
    setQueue([]);
    return generation;
  };
  /**
   * 에이전트를 바꿔 새로 띄운 세션에 아직 넘기지 못한 인계 문맥. 다음 전송 한 번에만
   * 실려 나가고 지워진다 — 매 전송마다 붙이면 새 세션의 컨텍스트를 계속 갉아먹는다.
   */
  const pendingHandoffRef = useRef<{ source: ProviderId; id: string; transcript: TranscriptItem[] } | null>(null);
  const chatLocalMemory = useChatLocalMemory();
  const queueChatSwitch = useSerializedTaskQueue();
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

  /**
   * 입력창의 글과 첨부를 한 벌로 옮긴다. 둘을 따로 옮기면 그사이 렌더에서 글과 첨부가
   * 서로 다른 시점의 값으로 보인다.
   */
  const putComposerDraft = useCallback((value: string, drafts: ChatAttachmentDraft[]) => {
    putComposerText(value);
    putComposerAttachments(drafts);
  }, [putComposerAttachments, putComposerText]);

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
    putTurns(surface.turns);
    putQueue(surface.queue);
    putComposerDraft(surface.composer, surface.attachments);
    putPhase(surface.phase);
    activeTurnRef.current = surface.activeTurnId;
  }, [putComposerDraft, putPhase, putQueue, putTurns]);

  /**
   * 채팅을 떠나기 전에 작성 중이던 글과 스크롤 위치를 그 채팅 몫으로 남긴다. 돌아올 때
   * `connectingChatSurface`가 이 초안을 다시 입력창에 올린다.
   */
  const rememberChatLocalState = useCallback((chatId: string) => {
    chatLocalMemory.remember(
      chatId,
      { text: composerRef.current, attachments: composerAttachmentsRef.current },
      chatStreamRef.current?.scrollTop ?? 0,
    );
  }, [chatLocalMemory]);

  /**
   * 종료 중 표시를 옮긴다. Set을 복사해 한 칸만 바꾸는 같은 모양이 시작·끝에 한 벌씩
   * 있었다.
   */
  const markChatClosing = useCallback((chatId: string, closing: boolean) => {
    setClosingChatIds((current) => {
      const next = new Set(current);
      if (closing) next.add(chatId); else next.delete(chatId);
      return next;
    });
  }, []);

  const providerOptions = useProviderOptions(source);
  // 새 채팅의 실행 계정 선택지. 계정 스냅샷이 바뀌어 고른 계정이 사라지거나 막히면
  // 기본값(활성 계정)으로 되돌려, 화면에 없는 계정으로 시작 요청을 보내지 않는다.
  const accountChoices = useMemo(() => launchAccountChoices(accounts, source), [accounts, source]);
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
  const { downloadLinkedFile, linkedFilePreview } = useChatLinkedFiles(activeChatId, text("연결된 채팅을 찾을 수 없습니다.", "Could not find connected chat."));

  // 탭마다 스크롤을 맡는 요소가 다르다. 훅은 이전 구간을 붙인 뒤 위치를 되돌릴 때만 읽으므로
  // 그 시점의 활성 탭 컨테이너를 돌려주는 프록시를 넘긴다.
  const historyScrollRef = useMemo(() => ({
    get current(): HTMLElement | null {
      return tab === "activity" ? activityLogRef.current : chatStreamRef.current;
    },
  }), [tab]);
  const transcript = useChatTranscriptHistory({
    session,
    turns,
    limit: transcriptLimit,
    onLimitChange: onTranscriptLimitChange,
    mode: tab === "activity" ? "activity" : "conversation",
    activityFilter,
    scrollContainerRef: historyScrollRef,
    onOpenLocalLink: linkedFilePreview.open,
  });

  // 대화 안에서 찾기(Cmd+F / Ctrl+F). 대화 탭과 작업 기록 탭이 각자 다른 요소를 굴리므로
  // 스크롤 컨테이너 프록시를 그대로 쓴다. 대화를 바꾸면 찾기는 닫힌다.
  const { findBar } = useChatFind({
    containerRef: historyScrollRef,
    enabled: Boolean(session) && tab !== "schedules",
    resetKey: activeChatId,
    priority: FIND_PRIORITY.chatView,
  });

  // 읽던 자리. 공급자 세션이 붙은 뒤부터 이 대화의 책갈피가 저장되므로, 세션 id가 아직
  // 없는 새 채팅에서는 목록이 비어 있고 저장도 하지 않는다.
  const { controls: readingControls, captureReadingPoint } = useReadingBookmarks({
    containerRef: chatStreamRef,
    source: session?.source ?? null,
    sessionId: session?.providerSessionId ?? null,
    resetKey: activeChatId,
    uiAnchor: "chat.reading-bookmarks",
    onMetaChanged,
  });

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
    putSession(info);
    putPhase(info.state);
    adoptSessionSettings(info);
    updateLiveChat(info);
  }, [adoptSessionSettings, putPhase, putSession, updateLiveChat]);

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

  // `put*` 손잡이가 이미 ref를 채우므로 그 손잡이로만 바뀌는 값(`session`·첨부 초안)은
  // 여기서 다시 맞추지 않는다. 아래 셋은 ref를 건드리지 않는 setter로도 바뀌므로
  // (이벤트 리듀서의 `setTurns`·`setQueue`, 재시작 절차의 `setPhase`) 렌더 뒤에 그릇을
  // 따라오게 한다.
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { turnsRef.current = turns; }, [turns]);
  useEffect(() => { queueRef.current = queue; }, [queue]);

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
      clearStaleError: true,
    });
  }, [applySessionInfo, onSessionCatalogChanged]);

  /**
   * 주어진 세대에 묶인 이벤트 수신기를 만든다. 연결을 걸 때마다 세대 검사를 손으로 적으면
   * 한 곳만 빠져도 떠난 연결의 이벤트가 지금 대화에 섞인다.
   */
  const eventsForGeneration = (generation: number) => (event: ChatEvent) => {
    if (generation === connectionGenerationRef.current) handleEvent(event);
  };

  // 새 응답이 흘러들어올 때 대화 탭을 맨 아래에 붙여 둔다. AIA 팝업과 같은 규칙을 쓴다.
  const {
    followingRef: followLatestMessagesRef,
    pause: pauseFollowingLatestMessages,
    resume: resumeFollowingLatestMessages,
  } = useFollowLatestMessages({
    targetRef: chatStreamRef,
    enabled: messageDisplayMode === "latest" && tab === "conversation",
    follow: messageDisplayMode === "latest",
    resetKey: activeChatId,
    growth: turns,
  });

  // '마지막 보낸 메시지부터' 모드: 채팅을 처음 열 때와 새 메시지를 보낼 때
  // 사용자 메시지가 화면 맨 위에 오도록 이동한다. 같은 위치는 다시 이동하지
  // 않으므로 응답이 흘러들어와도 읽던 자리가 밀리지 않는다.
  const lastUserMessageId = useMemo(() => lastUserMessageKey(turns), [turns]);
  useEffect(() => {
    if (messageDisplayMode !== "lastUser" || tab !== "conversation" || !activeChatId || !lastUserMessageId) return undefined;
    if (chatLocalMemory.lastUserMessageHandled(activeChatId, lastUserMessageId)) return undefined;
    const frame = window.requestAnimationFrame(() => {
      // 긴 답변을 읽다 말고 새 질문을 보내면 화면이 여기서 새 요청 자리로 옮겨 간다.
      // 읽던 자리를 잃는 지점이 바로 여기이므로, 옮기기 직전에 그 자리를 챙겨 둔다.
      captureReadingPoint();
      if (scrollToLastUserMessage(chatStreamRef.current)) {
        chatLocalMemory.markLastUserMessageHandled(activeChatId, lastUserMessageId);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [captureReadingPoint, chatLocalMemory, messageDisplayMode, tab, activeChatId, lastUserMessageId]);

  // 과거 구간이 위에 붙으면 스크롤 높이가 늘어나 읽던 자리가 밀린다. 원문이 처음 도착한
  // 시점에 메시지 표시 위치 설정을 다시 적용해 화면을 제자리에 맞춘다. 채팅마다 한 번만 한다.
  const historyPlacedChatRef = useRef<string | null>(null);
  useEffect(() => {
    if (!transcript.loaded || !activeChatId || historyPlacedChatRef.current === activeChatId) return undefined;
    historyPlacedChatRef.current = activeChatId;
    if (messageDisplayMode === "start") return undefined;
    const frame = window.requestAnimationFrame(() => {
      const container = tab === "activity" ? activityLogRef.current : chatStreamRef.current;
      if (!container) return;
      if (messageDisplayMode === "lastUser" && tab === "conversation" && scrollToLastUserMessage(container)) return;
      if (followLatestMessagesRef.current) container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeChatId, messageDisplayMode, tab, transcript.loaded]);

  useEffect(() => () => {
    const { connection } = takeConnection();
    if (connection) void connection.detach();
  }, []);

  const runChatSwitch = useCallback(async (chatId: string): Promise<boolean> => {
    const connected = connectionRef.current;
    if (connected?.info.chatId === chatId) {
      setTab("conversation");
      return true;
    }

    markChatSwitching(true);
    const previous = connected;
    const previousInfo = sessionRef.current ?? previous?.info ?? null;
    const previousSurface = captureChatSurface();
    if (previousInfo) rememberChatLocalState(previousInfo.chatId);

    const { generation } = takeConnection();
    setTab("conversation");
    setError(null);
    applyChatSurface(connectingChatSurface(chatLocalMemory.draftOf(chatId)));

    const restorable = previousInfo && previous ? { info: previousInfo, connection: previous } : null;
    try {
      const outcome = await switchAttachedChat({
        detachPrevious: previous ? () => previous.detach() : null,
        attachNext: async () => {
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
          const scrollTop = chatLocalMemory.scrollTopOf(nextConnection.info.chatId);
          if (scrollTop !== undefined) {
            window.requestAnimationFrame(() => chatStreamRef.current?.scrollTo({ top: scrollTop, behavior: "auto" }));
          }
          return true;
        },
        reattachPrevious: restorable && (async () => {
          const previousGeneration = bumpConnectionGeneration();
          const previousConnection = await attachChat(restorable.info.chatId, eventsForGeneration(previousGeneration));
          connectionRef.current = previousConnection;
          applyAttachSnapshot(previousConnection.info, previousGeneration);
          // 스냅숏이 세션 정보와 함께 단계까지 되돌려 놓으므로, 떠 둔 화면 상태는 그 뒤에 얹는다.
          applyChatSurface(previousSurface);
          return true;
        }),
        keepPrevious: restorable && (() => {
          connectionRef.current = restorable.connection;
          applySessionInfo(restorable.info);
          applyChatSurface(previousSurface);
          return true;
        }),
      });
      if (outcome.ok) return outcome.switched;
      if (!outcome.restored) putSession(null);
      reportFailure(outcome.restored
        ? `${text("이전 채팅은 유지했지만", "Previous chat was preserved, but")} ${text("채팅으로 전환하지 못했습니다", "failed to switch to chat")}`
        : text("채팅으로 전환하지 못했습니다", "Failed to switch to chat"), outcome.cause);
      return false;
    } finally {
      markChatSwitching(false);
      void refreshLiveChats();
    }
  }, [applyChatSurface, applySessionInfo, captureChatSurface, handleEvent, markChatSwitching, putSession, rememberChatLocalState, refreshLiveChats]);

  /**
   * 전환 요청을 순서대로 처리한다. 진행 중인 전환을 그냥 버리면 그 attach 결과를 받을
   * 주인이 없어(세대 검사에서 이벤트가 전부 버려져) 세션 정보만 있고 대화는 빈 화면으로
   * 남는다. 알림으로 이 화면을 처음 열 때(StrictMode의 이중 마운트·개발 HMR 재마운트)가
   * 그 경우였다.
   */
  const switchChat = useCallback((chatId: string): Promise<boolean> => {
    return queueChatSwitch(() => runChatSwitch(chatId));
  }, [queueChatSwitch, runChatSwitch]);

  useEffect(() => {
    if (!attentionTarget) return undefined;
    let cancelled = false;
    void switchChat(attentionTarget.chatId).then((opened) => {
      if (!cancelled) onAttentionTargetHandled(attentionTarget, opened);
    });
    return () => { cancelled = true; };
  }, [attentionTarget, onAttentionTargetHandled, switchChat]);

  const providerModels = models.filter((option) => option.source === source);
  const { launchAdvancedSettings } = useLaunchAdvancedSettings({
    source,
    catalog: providerOptions,
    recent: providerModels,
    extraSettings,
    onExtraSettingChange: (key, value) => setExtraSettings((current) => ({ ...current, [key]: value })),
  });
  const reasoningOptions = useCatalogReasoningOptions(providerOptions, model, reasoningEffort, () => setReasoningEffort(""));

  const addInitialFiles = (files: File[]) => {
    setInitialAttachments((current) => addAttachmentDrafts(current, files, setAttachmentNotice));
  };

  const addComposerFiles = (files: File[]) => {
    putComposerAttachments(addAttachmentDrafts(composerAttachmentsRef.current, files, setAttachmentNotice));
  };

  // 새 채팅 화면과 진행 중인 채팅 화면 어디에 놓아도 그 화면의 첨부 목록으로 들어간다.
  const { over: launchDropTarget, dropProps: launchDropProps } = useFileDropZone(addInitialFiles, starting, setAttachmentNotice);
  // 앞 첨부를 올리는 중에는 받지 않는다. 전송 절차가 목록을 스냅샷으로 덮어써,
  // 그사이 놓은 파일은 화면에서도 전송에서도 조용히 사라진다.
  const { over: chatDropTarget, dropProps: chatDropProps } = useFileDropZone(addComposerFiles, uploadingAttachments, setAttachmentNotice);

  const removeComposerAttachment = (draft: ChatAttachmentDraft) => {
    putComposerAttachments(composerAttachmentsRef.current.filter((item) => item.key !== draft.key));
    releaseAttachmentDraftUpload(draft, sessionRef.current?.chatId);
  };

  /**
   * 아직 만들지 않은 폴더를 작업 경로로 적고 시작하는 것은 흔한 첫 동작이다. 없는 경로일
   * 때만 만들지 물어보고, 승인하면 그 한 칸을 만든 뒤 같은 시작을 한 번 더 시도한다.
   * 실패가 이 종류가 아니거나 사용자가 거절하면 원래 실패를 그대로 올려 보낸다. 물음은
   * 브라우저 confirm이 아니라 화면 공용 확인 모달로 띄우고 만들 경로를 그대로 보여 준다.
   */
  const connectWithMissingDirectoryOffer = async (
    request: Parameters<typeof connectChat>[0],
    onEvent: Parameters<typeof connectChat>[1],
  ) => {
    try {
      return await connectChat(request, onEvent);
    } catch (cause) {
      const missing = missingDirectoryPath(errorText(cause));
      if (!missing) throw cause;
      // 없는 칸이 여럿이면 중간 칸도 새로 생긴다. 승인 전에 생길 것을 모두 보여 준다(C6-4b).
      const plan = await previewDirectoryCreation(missing).catch(() => null);
      const items = directoryCreationItems(plan, missing);
      const accepted = await confirm({
        title: text("새 폴더 만들기", "Create new folder"),
        message: items.length > 1
          ? text("이 경로에 폴더가 없습니다. 아래 폴더를 차례로 만들고 채팅을 시작할까요?", "There is no folder at this path. Create the following folders in order and start chat?")
          : text("이 경로에 폴더가 없습니다. 새로운 폴더를 만들고 채팅을 시작할까요?", "There is no folder at this path. Create a new folder and start chat?"),
        items,
        confirmLabel: text("만들고 시작", "Create and start"),
      });
      if (!accepted) throw cause;
      const created = await createDirectory(missing);
      setCwd(created.path);
      const connection = await connectChat({ ...request, cwd: created.path }, onEvent);
      // 첫 시도의 거절은 이벤트 흐름을 타고 이미 오류 배너에 실렸다(`chatSocketAttempt`가
      // 최초 거절을 `error` 이벤트로 올린다). 폴더를 만들고 다시 붙은 지금 그 배너는 더
      // 이상 현재 상태가 아닌데, 뒤따르는 `state` 이벤트는 배너를 지우지 않는다 — 지우는
      // 것은 새 턴과 리플레이뿐이라, 첫 메시지를 보내기 전까지 "경로를 찾을 수 없습니다"가
      // 멀쩡히 도는 채팅 위에 남아 있었다. 만들어 준 쪽이 여기서 걷는다.
      setError(null);
      return connection;
    }
  };

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (starting) return;
    setStarting(true);
    setError(null);
    putTurns([]);
    putPhase("connecting");
    try {
      const generation = bumpConnectionGeneration();
      const connection = await connectWithMissingDirectoryOffer(
        { source, accountId: launchAccountId || null, cwd: cwd.trim(), model: model.trim() || null, localConnectionId: localConnectionIdForRequest(source, localConnectionId), reasoningEffort: reasoningEffort || null, mode, approvalMode, resumeSessionId: null, unattended: false, settings: extraSettings },
        eventsForGeneration(generation),
      );
      connectionRef.current = connection;
      applyAttachSnapshot(connection.info, generation);
      saveChatLaunchSettings(source, { model: model.trim(), reasoningEffort, localConnectionId });
      if (connection.info.providerSessionId) {
        void onSessionCatalogChanged(connection.info.source, connection.info.providerSessionId);
      }
      const first = initialPrompt.trim();
      if (first || initialAttachments.length > 0) {
        putComposerDraft(first, initialAttachments);
        setInitialPrompt("");
        setInitialAttachments([]);
        setUploadingAttachments(true);
        await sendWithAttachmentDrafts(connection, first, initialAttachments, putComposerAttachments);
        putComposerDraft("", []);
      }
    } catch (cause) {
      if (connectionRef.current) {
        reportFailure(text("채팅은 시작했지만 첫 메시지를 보내지 못했습니다", "Chat started, but failed to send the first message"), cause);
      } else {
        putSession(null);
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
  const pendingApprovals = pendingChatApprovals(turns);
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
      setError(text("공급자 세션이 기록되기 전에 종료된 채팅이라 이어갈 수 없습니다. 새 채팅을 시작하세요.", "Cannot resume because the chat ended before the provider session was recorded. Please start a new chat."));
      return null;
    }
    markResuming(true);
    setError(null);
    const previousPhase = phaseRef.current;
    putPhase("connecting");
    const generation = await retireConnection(connectionRef.current);
    const adoptConnection = (nextConnection: ChatConnection) => {
      connectionRef.current = nextConnection;
      // 이전 chatId로 남은 초안·스크롤 기억은 다시 열릴 일이 없는 런타임의 것이다.
      chatLocalMemory.forget(current.chatId);
      putQueue([]);
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
        // 같은 세션은 같은 연결로 잇는다. 화면 값이 비어 있으면 세션이 보고한 연결을 쓴다.
        localConnectionId: localConnectionIdForRequest(current.source, localConnectionId || current.localConnectionId || ""),
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
          putPhase(previousPhase);
          reportFailure(text("기존 세션 실행에 연결하지 못했습니다", "Failed to connect to existing session run"), attachCause);
          return null;
        }
      }
      // 떼어낸 연결을 되돌려 놓아 봐야 이미 끊긴 구독이다. 상태만 종료된 그대로 돌려놓고
      // 다시 시도할 수 있게 둔다(이어가기는 연결이 아니라 세션 ID로 한다).
      putPhase(previousPhase);
      reportFailure(text("대화를 이어가지 못했습니다", "Failed to resume conversation"), cause);
      return null;
    } finally {
      markResuming(false);
      void refreshLiveChats();
    }
  };

  /**
   * 한도에 걸린 계정으로 실행 중이면, 보내기 전에 같은 대화를 지금의 기본 계정에서 다시
   * 연다. 자격증명은 CLI가 뜰 때 박히므로 살아 있는 실행에 그냥 보내면 같은 계정으로 나가
   * 같은 한도 오류가 돌아온다 — 기본 계정을 이미 바꿔 두었더라도 그렇다. 옮길지 말지는
   * `limitedAccountHandoff`가 정하고(고정 세션·막힌 계정은 제외), 재기동은 실행 계정을
   * 손으로 바꿀 때와 같은 경로를 쓴다.
   *
   * 응답 중인 턴은 건드리지 않는다. 돌고 있다는 것은 그 계정이 아직 받아 주고 있다는
   * 뜻이고, 여기서 끊으면 진행 중인 작업을 잃는다. 종료된 채팅의 이어가기는 백엔드가
   * 계정을 다시 풀므로(`resolve_start_account_plan`) 이 길을 타지 않는다.
   *
   * 옮기려다 실패했으면 false — 오류는 `changeActiveChatSettings`가 남겼고, 이번 전송은
   * 입력창의 글을 지우지 않고 멈춘다.
   */
  const reopenOnCurrentAccountIfLimited = async (): Promise<boolean> => {
    if (!session?.providerSessionId || phase !== "ready" || settingsChangeRef.current) return true;
    const handoff = limitedAccountHandoff({
      accounts,
      source: session.source,
      runtimeAccountId: session.accountId ?? null,
      pinnedAccountId: chatCatalogSession(session, sessions)?.meta.pinnedAccountId ?? null,
    });
    if (!handoff) return true;
    const previous = connectionRef.current;
    await changeActiveChatSettings({ accountId: handoff.toAccountId }, text("실행 계정을", "execution account"));
    if (connectionRef.current === previous) return false;
    setAccountHandoffNotice(text(
      `${handoff.fromLabel} 계정이 사용량 한도에 걸려, 이 대화를 ${handoff.toLabel} 계정에서 다시 열었습니다.`,
      `${handoff.fromLabel} hit its usage limit, so this conversation was reopened on ${handoff.toLabel}.`,
    ));
    return true;
  };

  /** deliverNow면 응답 중에도 중단 없이 진행 중인 작업에 바로 전달한다. */
  const deliverComposer = async (deliverNow: boolean) => {
    const draftText = composer.trim();
    const drafts = composerAttachmentsRef.current;
    if ((!draftText && drafts.length === 0) || uploadingAttachments) return;
    setAccountHandoffNotice(null);
    if (!await reopenOnCurrentAccountIfLimited()) return;
    // 종료된 채팅이면 먼저 이어간 뒤 그 런타임으로 보낸다.
    const connection = canResumeChat ? await resumeChat() : connectionRef.current;
    // 쓴 글이 있는데 보낼 길이 없으면 이유를 남긴다. 조용히 돌아가면 사용자에게는
    // 버튼이 먹지 않는 것과 구분되지 않는다(이어가기 실패는 resumeChat이 남긴다).
    if (!connection) {
      if (!canResumeChat) setError(text("이 채팅에 연결되어 있지 않아 메시지를 보내지 못했습니다. 채팅 목록에서 이 채팅을 다시 열어 주세요.", "Failed to send message because you are not connected to this chat. Please reopen this chat from the chat list."));
      return;
    }
    if (!canResumeChat && !composerUsable) {
      setError(`${text("지금은 메시지를 보낼 수 없는 상태입니다", "Cannot send messages right now")}(${phaseLabel(phase, text)}). ${text("잠시 뒤 다시 시도하세요.", "Please try again in a moment.")}`);
      return;
    }
    setError(null);
    setUploadingAttachments(true);
    try {
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
      await sendWithAttachmentDrafts(connection, outgoing, drafts, putComposerAttachments, { steer: deliverNow });
      putComposerDraft("", []);
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
    await runChatConnectionAction(connectionRef.current, action, setError);
  };

  const removeQueued = async (messageId: string) => {
    await runConnectionAction((connection) => connection.removeQueued(messageId));
  };

  const recallQueued = async (message: QueuedChatMessage) => {
    setError(null);
    try {
      await connectionRef.current?.removeQueued(message.id);
      const current = composerRef.current;
      putComposerDraft(
        current.trim() ? `${current}\n${message.text}` : message.text,
        [...composerAttachmentsRef.current, ...queuedAttachmentsToDrafts(message.attachments, connectionRef.current?.info.chatId ?? null)],
      );
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const decide = async (approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>, secret?: string, saveSecret?: boolean) => {
    await runConnectionAction((connection) => connection.approve(approvalId, decision, answers, secret, saveSecret));
    // 비밀값 줄은 맡긴 값이 있을 때만 나타난다(ChatSecretsPanel). 값이 들어가는 다른 길이
    // 이 카드이므로, 여기서 알려 주지 않으면 첫 값은 목록에 닿지 못하고 줄도 숨은 채다.
    if (secret !== undefined) setChatSecretSignal((current) => current + 1);
  };

  const interrupt = async () => {
    await runConnectionAction((connection) => connection.interrupt());
  };

  interface ActiveChatSettings extends ChatRuntimeSettings {
    /**
     * 이 실행이 쓸 계정. 빈 값은 "이어가기 설정이 정하는 계정"이다.
     *
     * 재연결에 이 값을 싣지 않으면 백엔드가 고정·이어가기 정책을 거쳐 활성 계정까지
     * 내려가므로, 모델만 바꿔도 채팅이 조용히 다른 계정으로 옮겨 갈 수 있다. 지금
     * 붙어 있는 계정을 그대로 실어 보내 그 이동을 막는다.
     */
    accountId: string;
  }

  /**
   * 같은 채팅을 새 실행으로 갈아끼운다. 설정 변경과 에이전트 인계가 각자 적던 뒷부분 —
   * 새 연결 요청, 연결 채택과 첫 스냅숏 반영, 실패했을 때 단계를 멈춤으로 내리기, 끝에서
   * 설정 변경 잠금 풀기 — 은 두 갈래가 같으므로 여기 한 벌로 둔다. 갈래마다 다른 것은
   * 요청값과 실패 문구, 연결 앞뒤로 할 일뿐이라 손잡이로 받는다.
   *
   * 종료에 실패하면 `beginChatRelaunch`가 화면을 되돌리고 여기서는 아무것도 하지 않는다.
   */
  const relaunchChat = async ({ onStopFailed, beforeConnect, request, onConnected, onConnectFailed }: {
    onStopFailed: (cause: unknown) => void;
    beforeConnect?: () => void;
    request: ChatStartRequest;
    onConnected?: (connection: ChatConnection) => Promise<void> | void;
    onConnectFailed: (cause: unknown) => void;
  }): Promise<void> => {
    const generation = await beginChatRelaunch({ onStopFailed });
    if (generation === null) return;
    beforeConnect?.();
    try {
      const nextConnection = await connectChat(request, eventsForGeneration(generation));
      connectionRef.current = nextConnection;
      applyAttachSnapshot(nextConnection.info, generation);
      await onConnected?.(nextConnection);
    } catch (cause) {
      setPhase("stopped");
      onConnectFailed(cause);
    }
    settingsChangeRef.current = false;
  };

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
      setError(`${label} ${text("변경하려면 공급자 세션 연결이 완료되어야 합니다.", "requires provider session connection to be completed.")}`);
      return;
    }

    const previous: ActiveChatSettings = current;

    applyRuntimeSettings(target);
    await relaunchChat({
      onStopFailed: (cause) => {
        applyRuntimeSettings(previous);
        reportFailure(`${label} ${text("변경하지 못했습니다", "failed to change")}`, cause);
      },
      request: {
        source: session.source,
        accountId: target.accountId || null,
        cwd: session.cwd,
        model: target.model.trim() || null,
        localConnectionId: localConnectionIdForRequest(session.source, target.localConnectionId ?? session.localConnectionId ?? ""),
        reasoningEffort: target.reasoningEffort || null,
        mode: target.mode,
        approvalMode: target.approvalMode,
        resumeSessionId: session.providerSessionId,
        unattended: false,
        settings: target.extraSettings,
      },
      onConnected: () => {
        saveChatLaunchSettings(session.source, {
          model: target.model.trim(),
          reasoningEffort: target.reasoningEffort,
          localConnectionId: target.localConnectionId ?? "",
        });
      },
      onConnectFailed: (cause) => reportFailure(`${label} ${text("변경 후 채팅에 다시 연결하지 못했습니다", "failed to reconnect to chat after change")}`, cause),
    });
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
    const originSessionId = requireProviderSessionId(text("에이전트를", "agent"));
    if (!originSessionId) return;
    await confirmAndRestart(plan, {
      title: text("에이전트를 바꿀까요?", "Change agent?"),
      message: plan
        ? planHandoffMessage(`${sourceName(nextSource)}: ${text("새 세션을 만들어 이 계획을 넘깁니다.", "Create a new session to hand off this plan.")}`, planModeNotice(mode))
        : `${sourceName(nextSource)}: ${text("새 세션을 만들고 지금까지의 대화를 인계합니다.", "Create a new session and hand over the conversation so far.")}\n${text("원본 세션은 변경하지 않고 그대로 남습니다.", "The original session remains unchanged.")}`,
      confirmLabel: plan ? planRestartConfirmLabel : text("새 세션으로 인계", "Hand over to new session"),
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
      await changeActiveChatSettings({ accountId: nextAccountId }, text("실행 계정을", "execution account"));
      return;
    }
    if ((session.accountId ?? "") === nextAccountId) return;
    if (!requireProviderSessionId(text("실행 계정을", "execution account"))) return;
    await confirmAndRestart(plan, {
      title: text("실행 계정을 바꿀까요?", "Change execution account?"),
      message: planHandoffMessage(text("같은 대화를 선택한 계정으로 다시 열어 이 계획을 넘깁니다.", "Reopen the same conversation with the selected account to hand off this plan."), planModeNotice(mode)),
      confirmLabel: planRestartConfirmLabel,
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
   * 사이에 답을 기다리는 계획이 있는데, 살아 있는 실행에 권한을 더 얹는 길은 승인 카드의
   * 두 선택뿐이다 — 승인 응답에 실어 보내는 편집 자동 승인('계획대로 실행 + 편집 자동
   * 승인')과, 계획 변경·질문 외의 권한 요청을 앱이 승인하는 전체 허용('계획대로 실행 +
   * 전체 허용(정책 제외)'). 실행 모드 자체를 넓히려면 접고 다시 띄우는 수밖에 없어,
   * 에이전트·실행 계정 변경과 같은 길을 지나며 계획 본문을 새 실행의 첫 요청으로 넘긴다.
   */
  const changeActiveChatMode = async (nextMode: ChatMode) => {
    if (!session || settingsChangeRef.current) return;
    const plan = pendingPlanApproval;
    if (!plan) {
      await changeActiveChatSettings({ mode: nextMode }, text("요청 모드를", "request mode"));
      return;
    }
    // 계획 모드로 되돌리는 것은 "계획을 다시 세우라"는 뜻이고, 그건 승인 카드의 '계획 다시
    // 세우기'가 할 일이다. 계획을 넘겨받을 실행을 읽기 전용으로 띄우지는 않는다.
    if (nextMode === mode || nextMode === "plan") return;
    if (!requireProviderSessionId(text("요청 모드를", "request mode"))) return;
    // 요청 모드는 여기서 직접 정하므로 `planModeNotice`가 알릴 것이 없다.
    await confirmAndRestart(plan, {
      title: text("요청 모드를 바꿀까요?", "Change request mode?"),
      message: planHandoffMessage(`${text("같은 대화를", "Reopen the same conversation in")} ${permissionModeLabel(nextMode)}${text("로 다시 열어 이 계획을 넘깁니다.", " mode to hand off this plan.")}`),
      confirmLabel: planRestartConfirmLabel,
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
    if (!providerSessionId) setError(`${label} ${text("바꾸려면 공급자 세션 연결이 완료되어야 합니다.", "requires provider session connection to be completed.")}`);
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
      ? `\n${text("요청 모드는 계획을 실행할 수 있도록", "Request mode changes to")} ${permissionModeLabel("workspace")}${text("로 바뀝니다.", " to execute the plan.")}`
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
    await relaunchChat({
      onStopFailed: (cause) => reportFailure(text("현재 실행을 종료하지 못했습니다", "Failed to stop current run"), cause),
      // 인계는 새 세션이라 이전 실행의 화면 기록을 이어받지 않는다. 같은 세션 재개는
      // 그대로 두어야 대화가 끊겨 보이지 않는다.
      beforeConnect: () => { if (handoff) putTurns([]); },
      request: {
        source: nextSource,
        accountId,
        cwd: current.cwd,
        model: handoff ? null : model.trim() || null,
        localConnectionId: handoff ? null : localConnectionIdForRequest(nextSource, localConnectionId || current.localConnectionId || ""),
        reasoningEffort: handoff ? null : reasoningEffort || null,
        mode: nextMode,
        approvalMode: handoff ? defaultApprovalMode(nextSource) : approvalMode,
        resumeSessionId: handoff ? null : current.providerSessionId,
        handoffOrigin: handoff,
        unattended: false,
        settings: handoff ? {} : extraSettings,
      },
      onConnected: async (nextConnection) => {
        if (handoff) {
          const context = { source: handoff.source, id: handoff.id, transcript: transcript.items };
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
      },
      onConnectFailed: (cause) => reportFailure(handoff
        ? text("인계할 새 세션을 시작하지 못했습니다", "Failed to start new session to hand off")
        : text("대화를 다시 연결하지 못했습니다", "Failed to reconnect conversation"), cause),
    });
    void refreshLiveChats();
  };

  const newChat = async () => {
    if (chatSwitchingRef.current) return;
    markChatSwitching(true);
    try {
      const connection = connectionRef.current;
      if (connection) {
        const current = sessionRef.current ?? connection.info;
        rememberChatLocalState(current.chatId);
        await connection.detach();
      }
      // 이미 떼어낸 연결이라 정리할 것은 없다. 세대만 올려 뒤늦은 이벤트를 버린다.
      takeConnection();
      putSession(null);
      applyChatSurface(connectingChatSurface());
      setError(null);
      // 실행 계정은 채팅 하나에만 적용하는 선택이다. 새 채팅은 기본값(활성 계정)에서 시작한다.
      setLaunchAccountId("");
      // 넘기려던 대화도 이 채팅과 함께 두고 간다.
      pendingHandoffRef.current = null;
      loadLatestRuntimeOptions(source);
    } catch (cause) {
      reportFailure(text("현재 채팅을 백그라운드로 보내지 못했습니다", "Failed to send current chat to background"), cause);
    } finally {
      markChatSwitching(false);
      void refreshLiveChats();
    }
  };

  /**
   * 이 대화를 원본으로 새 세션을 갈라낸다(fork). 원본 채팅은 "새 채팅"처럼 백그라운드에
   * 두고, 같은 경로·모델·추론·권한으로 원본 대화를 이어받은 새 세션을 이 자리에 띄운다.
   * 원본 공급자 세션은 건드리지 않으므로 채팅 목록에서 언제든 다시 열 수 있다.
   */
  const forkChat = async () => {
    const current = sessionRef.current;
    const originSessionId = current?.providerSessionId;
    if (!current || !originSessionId || !supportsSessionFork(current.source) || chatSwitchingRef.current) return;
    markChatSwitching(true);
    setError(null);
    try {
      const connection = connectionRef.current;
      if (connection) {
        rememberChatLocalState(current.chatId);
        await connection.detach();
      }
      takeConnection();
      putTurns([]);
      putPhase("connecting");
      const generation = bumpConnectionGeneration();
      const forked = await connectChat({
        source: current.source,
        cwd: current.cwd,
        model: model.trim() || null,
        reasoningEffort: reasoningEffort || null,
        mode,
        approvalMode,
        forkSessionId: originSessionId,
        unattended: false,
        settings: extraSettings,
      }, eventsForGeneration(generation));
      connectionRef.current = forked;
      applyAttachSnapshot(forked.info, generation);
      if (forked.info.providerSessionId) {
        void onSessionCatalogChanged(forked.info.source, forked.info.providerSessionId);
      }
    } catch (cause) {
      putSession(null);
      setError(`${text("대화를 포크하지 못했습니다", "Failed to fork the conversation")}: ${errorText(cause)}`);
    } finally {
      markChatSwitching(false);
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
   * 채팅 목록 행의 즐겨찾기. 즐겨찾기는 세션 메타에 달리므로 공급자 세션이 아직 없는
   * 채팅(첫 응답 전)에는 달 곳이 없다 — 그때는 버튼을 비활성으로 두고 사유를 툴팁에
   * 남긴다. 바뀐 메타는 App의 스냅샷으로 올려 세션 목록·대시보드와 갈라지지 않게 한다.
   */
  const toggleChatFavorite = useCallback(async (chat: ChatSessionInfo) => {
    const target = chatCatalogSession(chat, sessions);
    if (!target) return;
    await saveSessionMetaPatch(
      target.source,
      target.id,
      target.meta,
      { favorite: !target.meta.favorite },
      (meta) => onMetaChanged(target.source, target.id, meta),
      setError,
    );
  }, [sessions, onMetaChanged]);

  /**
   * 채팅 실행 종료 확인을 받는다. 현재 채팅과 배경 채팅은 안내 문구만 다르고 제목·버튼·
   * '다음부터 표시 안 함' 처리가 같으므로, 확인을 꺼 둔 사용자를 묻지 않고 통과시키는
   * 판단까지 여기 둔다. 어느 문구를 쓸지는 갈래·진행 여부만 넘기면 `chatCloseConfirmMessage`가
   * 정한다 — 호출부가 문구를 들고 있으면 한쪽만 고쳐 같은 동작을 두 가지로 설명하게 된다.
   */
  const confirmChatClose = async (scope: ChatCloseScope, active: boolean): Promise<boolean> => {
    if (!shouldConfirmChatClose()) return true;
    return confirm({
      title: text("채팅 실행을 종료할까요?", "Close chat run?"),
      message: chatCloseConfirmMessage(scope, active),
      confirmLabel: text("종료", "Close"),
      tone: "danger",
      checkbox: {
        label: text("다음부터 표시 안 함", "Do not show again"),
        onConfirm: (checked) => { if (checked) hideChatCloseConfirmation(); },
      },
    });
  };

  /**
   * 종료가 끝난 채팅을 화면 목록과 로컬 기억에서 함께 지운다. 두 갈래가 각자 두 줄로
   * 적고 있었는데, 한쪽만 지우면 다시 열릴 일이 없는 채팅의 작성 초안·읽던 자리가 남는다.
   */
  const dropClosedChat = (chatId: string) => {
    setLiveChats((chats) => chats.filter((chat) => chat.chatId !== chatId));
    chatLocalMemory.forget(chatId);
  };

  const stopCurrentChat = async () => {
    const connection = connectionRef.current;
    const current = sessionRef.current;
    if (!connection || !current || chatSwitchingRef.current) return;
    const active = phaseRef.current === "running" || phaseRef.current === "waitingApproval";
    const accepted = await confirmChatClose("current", active);
    if (!accepted) return;

    const nextChatId = openChats.find((chat) => chat.chatId !== current.chatId)?.chatId ?? null;
    markChatSwitching(true);
    setError(null);
    try {
      await connection.stop();
    } catch (cause) {
      reportFailure(text("채팅 실행을 종료하지 못했습니다", "Failed to close chat run"), cause);
      markChatSwitching(false);
      return;
    }
    await retireConnection(connection);
    dropClosedChat(current.chatId);
    putSession(null);
    applyChatSurface(connectingChatSurface());
    markChatSwitching(false);
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
    const accepted = await confirmChatClose("background", active);
    if (!accepted) return;

    // 이 경로는 소켓을 새로 붙여 CLI 프로세스를 끝낼 때까지 몇 초가 걸린다. 그동안
    // chatSwitching으로 목록 전체를 잠그면 다른 채팅으로 옮기지도, 새 채팅을 열지도 못한다.
    // 지우는 행만 목록에서 먼저 빼고, 나머지 목록은 계속 쓸 수 있게 둔다.
    setError(null);
    markChatClosing(chat.chatId, true);
    let backgroundConnection: ChatConnection | null = null;
    try {
      backgroundConnection = await attachChat(chat.chatId, () => {});
      await backgroundConnection.stop();
      await detachQuietly(backgroundConnection);
      dropClosedChat(chat.chatId);
    } catch (cause) {
      await detachQuietly(backgroundConnection);
      reportFailure(text("채팅을 종료하지 못했습니다", "Failed to close chat"), cause);
    } finally {
      // 서버 목록이 이 채팅을 실제로 뺐는지 확인한 뒤에 가림을 푼다. 먼저 풀면 종료 요청
      // 전에 떠난 폴링 응답이 방금 지운 행을 잠깐 되살린다. 실패했다면 행이 다시 보인다.
      try { await refreshLiveChats(); } catch { /* 폴링이 곧 다시 맞춘다. */ }
      markChatClosing(chat.chatId, false);
    }
  };

  const openInCodex = async () => {
    const providerSessionId = session?.providerSessionId;
    if (session?.source !== "codex" || !providerSessionId || openingProviderApp) return;
    setOpeningProviderApp(true);
    setError(null);
    const { connection } = takeConnection();
    try {
      await shutdownConnection(connection);
      setPhase("stopped");
      setQueue([]);
      await openProviderSessionApp(session.source, providerSessionId);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setOpeningProviderApp(false);
    }
  };


  // 팝아웃 창은 이 대화 하나만 담당한다. 보기 전환과 채팅 목록은 본 창의 몫이므로,
  // 창에는 대화 패널만 남겨 창 전체를 쓰게 한다.
  const tabs = popout ? null : (
    <div className="chat-hub-tabs">
      {tab !== "schedules" && !chatListOpen && <button ref={chatListPane.restoreRef} className="secondary-pane-restore chat-list-restore" type="button" aria-label={text("채팅 목록 보기", "Show chat list")} title={text("채팅 목록 보기", "Show chat list")} aria-expanded={false} onClick={() => chatListPane.setVisibility(true)}><PanelLeftOpen size={15} aria-hidden="true" /><span>{text("채팅", "Chat")}</span></button>}
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

  const runtimeList = <ChatRuntimeList
    pane={chatListPane}
    chats={openChats}
    sessions={sessions}
    activeChatId={activeChatId}
    busy={chatSwitching}
    popout={popout}
    onNewChat={newChat}
    onSwitchChat={switchChat}
    onToggleFavorite={(chat) => { void toggleChatFavorite(chat); }}
    onPopOut={popOutChat}
    onStopChat={(chat) => { void stopBackgroundChat(chat); }}
  />;

  if (tab === "schedules") {
    return <div className={`chat-hub${popout ? " popout" : ""}`}>{tabs}<SchedulesPanel providers={available} accounts={accounts} projects={projects} models={models} sessions={sessions} snapshot={scheduler} onRefresh={onRefreshScheduler} onSnapshot={onSchedulerSnapshot} currentSession={session} currentPrompt={composer} onOpenSession={onOpenSession} /></div>;
  }

  if (!session) {
    return (
      <div className={`chat-hub${popout ? " popout" : ""}`}>
        {tabs}
        <section className={`chat-runtime-layout${tab === "conversation" ? " chat-runtime-launch-shell" : ""}${chatListOpen ? " list-open" : " list-hidden"}`}>
          {runtimeList}
          {tab === "activity" ? <div className="chat-runtime-empty"><EmptyState title={text("표시할 작업 로그가 없습니다", "No activity logs to display")} detail={text("대화를 시작하면 요청별 추론과 도구 실행이 여기에 모입니다.", "Reasoning and tool executions per request will gather here once a conversation starts.")} /></div> : (
            <ChatLaunchForm
              draft={runtimeDraft}
              available={available}
              accounts={accounts}
              projects={projects}
              accountChoices={accountChoices}
              activeAccountId={launchActiveAccountId}
              catalog={providerOptions}
              recentModels={providerModels}
              reasoningOptions={reasoningOptions}
              cliConnectionCards={cliConnectionCards}
              advancedSettings={launchAdvancedSettings}
              prompt={initialPrompt}
              onPromptChange={setInitialPrompt}
              attachments={initialAttachments}
              onAddFiles={addInitialFiles}
              onRemoveAttachment={(draft) => setInitialAttachments((current) => current.filter((item) => item.key !== draft.key))}
              starting={starting}
              error={error}
              notice={attachmentNotice}
              dropOver={launchDropTarget}
              dropProps={launchDropProps}
              onSubmit={start}
            />
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
    disabledReason: provider.cli.detected ? null : text("이 공급자의 CLI가 연결되어 있지 않습니다", "CLI for this provider is not connected"),
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
        <section className="structured-chat chat-drop-zone" {...chatDropProps}>
        {chatDropTarget && <FileDropOverlay />}
        <header className="chat-session-header">
          <div><span className={`terminal-status terminal-status-${phase}`} /><div><strong>{sourceName(session.source)} · {phaseLabel(phase, text)}</strong><small>{displayPath(session.cwd)}{runningAccountLabel ? ` · ${text("계정", "Account")} ${runningAccountLabel}` : ""}</small></div></div>
          <div className="chat-session-actions">
            {(phase === "stopped" || phase === "failed") && session.providerSessionId && <button className="button primary" type="button" disabled={!canResumeChat} onClick={() => void resumeChat()} title={text("같은 공급자 대화를 다시 띄워 이어갑니다", "Reopens the same provider conversation and continues it")}><RotateCw size={13} />{resuming ? text("이어가는 중…", "Resuming…") : text("이어가기", "Resume")}</button>}
            {/* 좁은 화면에서 팝아웃은 같은 탭을 밀어내는 꼴이라 쓸모가 없다. 그 자리를 새 채팅이 대신 쓰고,
                두 버튼은 CSS 미디어쿼리로 갈라 끼운다(뷰포트를 JS로 재느니 화면 폭에 맡긴다). */}
            {!popout && <button className="button chat-session-popout-action" type="button" onClick={() => popOutChat(session.chatId)} title={text("이 채팅을 별도 창으로 엽니다. 이 창의 대화도 그대로 유지됩니다.", "Opens this chat in a separate window. The conversation here stays as is.")}><AppWindow size={13} />{text("새 창으로 열기", "Open in new window")}</button>}
            {!popout && <button className="button chat-session-new-chat-action" type="button" disabled={chatSwitching} onClick={() => { setTab("conversation"); void newChat(); }} title={text("이 채팅은 백그라운드로 두고 새 채팅을 시작합니다", "Keeps this chat in the background and starts a new one")}><Plus size={13} />{text("새 채팅", "New chat")}</button>}
            {!popout && supportsSessionFork(session.source) && <button className="button chat-session-fork-action" type="button" disabled={!session.providerSessionId || chatSwitching || chatBusy || phase === "connecting"} onClick={() => { setTab("conversation"); void forkChat(); }} title={session.providerSessionId ? text("이 대화를 이어받은 새 세션을 만듭니다. 원본 채팅은 백그라운드에 남습니다.", "Starts a new session that carries this conversation over. The original chat stays in the background.") : text("첫 응답을 받아 세션이 생긴 뒤에 포크할 수 있습니다", "You can fork once the first reply creates a session")}><GitBranch size={13} />{text("포크", "Fork")}</button>}
            {hasTauriRuntime() && session.source === "codex" && session.providerSessionId && <button className="button" type="button" disabled={openingProviderApp || phase === "running" || phase === "waitingApproval"} onClick={() => void openInCodex()} title={text("이 연결을 종료하고 같은 대화를 Codex 앱에서 엽니다", "Closes this connection and opens the same conversation in the Codex app")}><ExternalLink size={13} />{openingProviderApp ? text("여는 중…", "Opening…") : text("Codex에서 열기", "Open in Codex")}</button>}
          </div>
        </header>
        <div className="chat-session-meta"><code>{session.providerSessionId ?? session.chatId}</code><span>{session.model ?? text("기본 모델", "Default model")}</span><span>{text("추론", "Reasoning")} {session.reasoningEffort ? reasoningLabel(session.reasoningEffort) : text("기본", "Default")}</span><span>{permissionModeLabel(session.mode)}</span>{session.planAutoApproval && <span>{text("전체 허용(정책 제외)", "All allowed except decisions")}</span>}{settingField(settingFieldsFor(providerOptions, session.source), "approvalMode") && <span>{approvalModeLabel(session.approvalMode)}</span>}</div>
        {error && <div className="chat-inline-error"><ErrorBanner message={error} /></div>}
        {attachmentNotice && <div className="chat-inline-error"><ErrorBanner message={attachmentNotice} /></div>}
        {accountHandoffNotice && <div className="chat-inline-note"><NoticeBanner message={accountHandoffNotice} /></div>}
        {/* 찾기 막대는 대화 위에 떠 있다(스크롤 조작 묶음과 같은 껍데기 안). 흐름에 끼워 넣으면
            열 때마다 대화가 아래로 밀린다. 두 탭이 각자 스크롤을 맡으므로 껍데기도 각자 쓴다. */}
        {tab === "activity" ? (
          <div className="chat-stream-shell">
            <ChatActivityLog containerRef={activityLogRef} history={transcript.history} turns={turns} chatId={activeChatId} filter={activityFilter} onFilter={setActivityFilter} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} />
            {findBar}
          </div>
        ) : (
          <div className="chat-stream-shell">
            <div className="chat-stream" aria-live="polite" ref={chatStreamRef}>
              {transcript.history}
              {turns.length === 0 && !transcript.history && <EmptyState title={text("CLI가 연결되었습니다", "CLI connected")} detail={text("아래 입력창에서 첫 메시지를 보내세요.", "Send your first message from the composer below.")} />}
              {turns.map((turn) => <ChatConversationTurn turn={turn} chatId={activeChatId} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} key={turn.id} />)}
            </div>
            <ChatScrollControls
              targetRef={chatStreamRef}
              leading={readingControls}
              onScrollAwayFromLatest={pauseFollowingLatestMessages}
              onScrollToLatest={resumeFollowingLatestMessages}
            />
            {findBar}
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
          onOpen={() => loadLatestRuntimeOptions(session.source)}
          onAgentChange={(nextSource) => void changeActiveChatAgent(nextSource)}
          onAccountChange={(nextAccountId) => void changeActiveChatAccount(nextAccountId)}
          onModeChange={(nextMode) => void changeActiveChatMode(nextMode)}
          onApprovalModeChange={(nextMode) => void changeActiveChatSettings({ approvalMode: nextMode }, text("승인 처리를", "approval mode"))}
          onModelChange={(nextModel) => void changeActiveChatSettings({ model: nextModel }, text("응답 모델을", "response model"))}
          onReasoningEffortChange={(nextEffort) => void changeActiveChatSettings({ reasoningEffort: nextEffort }, text("추론 수준을", "reasoning effort"))}
          onExtraSettingsApply={(nextSettings) => void changeActiveChatSettings({ extraSettings: nextSettings }, text("추가 설정을", "extra settings"))}
        />
        <ChatSecretsPanel chatId={activeChatId} disabled={phase === "connecting"} refreshSignal={chatSecretSignal} />
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
          onChange={putComposerText}
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


