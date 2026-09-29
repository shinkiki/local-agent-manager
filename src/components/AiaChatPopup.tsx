import { type ClipboardEventHandler, type FormEvent, type KeyboardEventHandler, type MutableRefObject, type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Send, Square, X } from "lucide-react";
import { attachChat, connectChat, supportsDeliveryDuringTurn, type ChatConnection } from "../lib/chat";
import { useMirroredState } from "./ChatMirroredState";
import {
  addAttachmentDrafts,
  AttachmentPicker,
  movableAttachmentDrafts,
  queuedAttachmentsToDrafts,
  releaseAttachmentDraftUpload,
  sendWithAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { enableAiaWindowSessions, rememberAiaWindowSession, selectAiaWindowSession } from "../lib/aiaWindowSession";
import { openPopoutWindow } from "../lib/popoutWindow";
import { submitComposerOnEnter } from "../lib/composerKeys";
import { attachPastedFiles, useComposerSendState, type ChatComposerDraftHandles } from "./ChatComposer";
import { aiaChatsForProvider, aiaRuntimeNeedsRestart, aiaStaleSendAction, supportsAiaSystemTools, type AiaRuntimeSettings } from "../lib/aiaRuntime";
import { aiaAttentionTargetAction } from "../lib/aiaAttention";
import { getLiveChats } from "../lib/ipc";
import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatPhase,
  ChatSessionInfo,
  ProviderId,
  QueuedChatMessage,
} from "../types";
import {
  detachQuietly,
  runChatConnectionAction,
  shutdownConnection,
} from "./ChatConnectionAction";
import { switchAttachedChat, useChatConnectionGeneration } from "./ChatConnectionGeneration";
import { useChatLinkedFiles } from "./ChatLinkedFiles";
import { FIND_PRIORITY, useChatFind } from "./ChatFindBar";
import { useReadingBookmarks } from "./ReadingBookmarks";
import { liveMessageKey } from "../lib/readingAnchor";
import { LinkedFilePreview } from "./LinkedFilePreview";
import {
  applyChatEvent,
  chatActivityCounts,
  ChatEntryView,
  ChatMessageArticle,
  ChatScrollControls,
  ChatTurnSegments,
  pendingChatApprovals,
  useFollowLatestMessages,
  type ChatActivityEntry,
  type ChatEntry,
  type ChatEntryActions,
  type ChatTurn,
} from "./ChatConversation";
import { VoiceInputControl } from "./VoiceControls";
import { mergeComposerDraft, type AiaSuggestion } from "../lib/aiaSuggestions";
import { errorText } from "../lib/errorText";
import { useI18n, type UiText } from "../lib/i18n";
import {
  AiaMark,
  ChatApprovalDock,
  ChatQueueList,
  ChatSendActionMenu,
  ErrorBanner,
  FileDropOverlay,
  useEscapeToClose,
  useFileDropZone,
} from "./Shared";

/** 붙기 결과. stale은 뒤에 시작된 작업이 화면을 맡아 이 연결을 버렸다는 뜻이다. */
type AiaAttachResult = "attached" | "failed" | "stale";

interface AiaChatPopupProps {
  windowId?: string | null;
  open: boolean;
  /** 시스템 설정에서 고른 시스템 에이전트. AIA 런타임이 이 공급자로 실행된다. */
  provider: ProviderId;
  /**
   * 설정 화면에 저장된 이 공급자의 AIA 실행설정. 백엔드가 AIA를 시작할 때 쓰는 값과 같으며,
   * 저장본이 바뀌면 다음 요청을 보낼 때 돌던 대화를 정지하고 새 설정으로 다시 시작하는
   * 근거가 된다.
   */
  runtime: AiaRuntimeSettings;
  providerName: string;
  providerConnected: boolean;
  attentionTarget: AiaAttentionTarget | null;
  autoPrompt: AiaAutoPrompt | null;
  suggestions: AiaSuggestion[];
  onClose: () => void;
  onConnectProvider: () => void;
  onAttentionTargetHandled: (target: AiaAttentionTarget, opened: boolean) => void;
  onAutoPromptHandled: (prompt: AiaAutoPrompt, sent: boolean) => void;
  onDismissSuggestion: (suggestion: AiaSuggestion) => void;
  /**
   * 이 화면이 버린 대화를 알린다(새 대화 시작, 실행설정 어긋남으로 정지). 앱은 그 대화에
   * 남은 AIA 알림을 걷어, 상단바 트리거가 버린 대화로 되돌아가지 않게 한다.
   */
  onDiscardChat: (chatId: string) => void;
  /** 팝업이 닫혀 있어도 상단바 트리거가 진행 중 표시를 켤 수 있도록 실행 상태를 알린다. */
  onBusyChange: (busy: boolean) => void;
  /** AIA가 show_ui_guide로 보낸 화면 안내를 앱에 넘긴다. false가 오면 대상을 화면에서 찾지 못한 것이다. */
  onUiGuide: (event: Extract<ChatEvent, { type: "uiGuide" }>) => Promise<boolean>;
  /** AIA가 find_ui_elements로 보낸 요소 조회. 앱이 화면을 스캔해 answer_ui_query로 답한다. */
  onUiQuery: (event: Extract<ChatEvent, { type: "uiQuery" }>) => void;
  /** AIA가 open/click_ui_element로 보낸 클릭 요청. 앱이 AIA 커서를 움직여 누르고 결과를 답한다. */
  onUiClick: (event: Extract<ChatEvent, { type: "uiClick" }>) => void;
  /** 화면 안내가 가리키는 요소를 팝업이 덮고 있어 왼쪽으로 비켜나야 하는 동안 true. */
  yieldForGuide?: boolean;
}

export interface AiaAttentionTarget {
  chatId: string;
  attentionId: string;
  markRead: boolean;
  requestId: number;
}

/** 앱 UI(예: 실행설정 새로고침)가 AIA에게 자동으로 전달하는 요청 메시지. */
export interface AiaAutoPrompt {
  text: string;
  requestId: number;
}

export function AiaChatPopup({ open, provider, runtime, providerName, providerConnected, attentionTarget, autoPrompt, suggestions, onClose, onConnectProvider, onAttentionTargetHandled, onAutoPromptHandled, onDismissSuggestion, onDiscardChat, onBusyChange, onUiGuide, onUiQuery, onUiClick, yieldForGuide = false, windowId = null }: AiaChatPopupProps) {
  const { text } = useI18n();
  const [session, setSession] = useState<ChatSessionInfo | null>(null);
  const [phase, setPhase] = useState<ChatPhase | "connecting">("connecting");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [queue, setQueue] = useState<QueuedChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 시작 여부는 화면(버튼 비활성·연결 중 안내)과 절차(중복 시작 차단)가 함께 읽으므로
  // 두 그릇에 함께 담는다.
  const [starting, startingRef, putStarting] = useMirroredState(false);
  const activeTurnRef = useRef<string | null>(null);
  const autoStartedRef = useRef(false);
  const restartingRef = useRef(false);
  const handledAutoPromptRef = useRef(0);
  // 알림 전환은 요청 하나당 한 번만 실행한다. `starting`이 바뀌면 이 이펙트의 의존값이
  // 바뀌어 진행 중인 전환의 결과가 버려지는데(cancelled), 그 결과를 아무도 소비하지 않으면
  // 대상이 그대로 남아 이펙트가 다시 전환을 걸고, 실행설정 재시작과 맞물려 붙기·정지가
  // 끝없이 돈다(팝업이 "연결 중"에서 깜박임).
  const handledAttentionRequestRef = useRef(0);
  // 실행설정이 어긋나 정지시킨 대화. 이 화면에서는 다시 고르지 않는다 — 다시 붙으면
  // 붙자마자 또 정지 대상이 되어 같은 깜박임으로 돌아온다.
  const discardedChatsRef = useRef(new Set<string>());
  const streamRef = useRef<HTMLDivElement>(null);
  const busy = phase === "running" || phase === "waitingApproval";
  const composerUsable = Boolean(session) && (phase === "ready" || busy);

  const applySession = useCallback((next: ChatSessionInfo) => {
    try { rememberAiaWindowSession(window.localStorage, window.sessionStorage, windowId, next.chatId); } catch { /* 저장이 막혀도 현재 연결은 유지한다. */ }
    setSession(next);
    setPhase(next.state);
  }, [windowId]);

  const {
    connectionRef,
    nextGeneration,
    isCurrent: isCurrentGeneration,
    claim: claimConnection,
    take: takeConnection,
    queue: queueConversationWork,
  } = useChatConnectionGeneration(applySession);

  const draft = useAiaComposerDraft({ connectionRef, providerConnected, usable: composerUsable, onError: setError });
  const { composer, setComposer, attachments, insertPrompt, clearAttachments: clearDraftAttachments } = draft;

  /**
   * 새 연결 시도가 화면을 맡는다. 세대를 올려 앞선 시도의 이벤트를 버리게 하고 지난 대화의
   * 잔상을 지운 뒤, 이 시도가 자기 이벤트인지 가릴 때 쓸 세대를 돌려준다.
   */
  const beginConversationAttempt = useCallback((): number => {
    putStarting(true);
    setError(null);
    setTurns([]);
    setQueue([]);
    setPhase("connecting");
    return nextGeneration();
  }, [nextGeneration, putStarting]);

  const endConversationAttempt = useCallback(() => {
    putStarting(false);
  }, [putStarting]);

  const activeChatId = session?.chatId ?? null;
  const { downloadLinkedFile, linkedFilePreview } = useChatLinkedFiles(
    activeChatId,
    text("연결된 AIA 대화를 찾을 수 없습니다.", "No linked AIA conversation was found."),
  );

  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.type === "uiGuide") {
      // 대화 목록에는 넣지 않는다. 화면의 화살표가 곧 이 이벤트의 표시다.
      void onUiGuide(event).then((shown) => {
        if (shown) return;
        const subject = event.target ?? event.element?.text ?? event.element?.ref ?? "?";
        setError(`${text("화면에서 안내할 위치를 찾지 못했습니다", "Could not find the place to point to on screen")}: ${subject}`);
      });
      return;
    }
    if (event.type === "uiQuery") {
      onUiQuery(event);
      return;
    }
    if (event.type === "uiClick") {
      onUiClick(event);
      return;
    }
    applyChatEvent(event, {
      activeTurnRef,
      setTurns,
      setQueue,
      onState: applySession,
      onError: setError,
      clearStaleError: false,
    });
  }, [applySession, onUiClick, onUiGuide, onUiQuery, text]);

  /** 연결 시도가 아직 화면을 맡고 있을 때만 그 연결의 이벤트를 전달한다. */
  const handleEventsForGeneration = useCallback((generation: number) => (event: ChatEvent) => {
    if (isCurrentGeneration(generation)) handleEvent(event);
  }, [handleEvent, isCurrentGeneration]);

  const startConversation = useCallback(async () => {
    if (!providerConnected || startingRef.current) return;
    const generation = beginConversationAttempt();
    try {
      // 실행설정(권한 모드·승인 방식·모델·추론 강도·동적 설정)은 백엔드가 설정 화면에
      // 저장한 시스템 에이전트 실행설정으로 바꿔 시작한다. 저장된 값이 없으면 여기 적힌
      // 기존 기본값과 같은 값으로 실행된다.
      const connection = await connectChat({
        source: provider,
        cwd: "",
        model: null,
        reasoningEffort: "medium",
        mode: "workspace",
        approvalMode: "manual",
        resumeSessionId: null,
        unattended: false,
        profile: "aia",
      }, handleEventsForGeneration(generation));
      await claimConnection(generation, connection);
    } catch (cause) {
      setSession(null);
      setError(errorText(cause));
      setPhase("failed");
    } finally {
      endConversationAttempt();
    }
  }, [beginConversationAttempt, claimConnection, endConversationAttempt, handleEventsForGeneration, provider, providerConnected]);

  const attachConversation = useCallback(async (chatId: string): Promise<AiaAttachResult> => {
    const generation = beginConversationAttempt();
    try {
      const connection = await attachChat(chatId, handleEventsForGeneration(generation));
      return (await claimConnection(generation, connection)) ? "attached" : "stale";
    } catch {
      setSession(null);
      return "failed";
    } finally {
      endConversationAttempt();
    }
  }, [beginConversationAttempt, claimConnection, endConversationAttempt, handleEventsForGeneration]);

  const runRestoreOrStartConversation = useCallback(async () => {
    // 작업은 promise 꼬리에서 순차 실행된다. 기다리는 동안 앞 작업이 연결을 끝냈다면 이
    // 복원은 이미 충족됐다. 다시 attach/start하면 현재 대화를 먼저 비워 사용자 메시지가
    // 깜박이고, 교체 전 WebSocket과 빈 AIA 런타임이 계속 쌓인다.
    if (connectionRef.current) return;
    if (windowId) {
      try { enableAiaWindowSessions(window.localStorage); } catch { /* 복원 함수는 저장소 장애 때 다른 대화를 선택하지 않는다. */ }
    }
    // 세대 경합으로 버려진 붙기(stale)는 그 결과를 대신 받을 작업이 없으므로 현재 세대로
    // 한 번 더 시도한다. 그 밖의 결과는 기존대로 새 대화 시작으로 넘어간다.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const liveChats = await getLiveChats("aia");
        // 이전 공급자나 예전 실행설정으로 시작한 AIA 대화에는 다시 붙지 않는다. 붙으면
        // 저장한 권한·모델이 아니라 그 대화가 시작할 때의 설정으로 계속 돌게 된다.
        const candidates = aiaChatsForProvider(liveChats, provider, runtime)
          .filter((chat) => !discardedChatsRef.current.has(chat.chatId));
        const selected = selectAiaWindowSession(candidates, window.localStorage, window.sessionStorage, windowId);
        if (!selected) break;
        const result = await attachConversation(selected.chatId);
        if (result === "attached") return;
        if (result === "failed") break;
      } catch {
        // A snapshot failure must not prevent AIA from starting a fresh conversation.
        break;
      }
    }
    await startConversation();
  }, [attachConversation, connectionRef, provider, runtime, startConversation, windowId]);

  const restoreOrStartConversation = useCallback(
    () => queueConversationWork(runRestoreOrStartConversation),
    [queueConversationWork, runRestoreOrStartConversation],
  );

  useEffect(() => {
    if ((!open && !autoPrompt) || !providerConnected || attentionTarget || connectionRef.current || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void restoreOrStartConversation();
  }, [attentionTarget, autoPrompt, open, providerConnected, restoreOrStartConversation]);

  /**
   * 실행설정(권한·승인·판단·모델·추론)은 CLI 실행 인자와 개발자 지침으로 들어가므로 대화
   * 중에는 바꿀 수 없다. 시스템 에이전트를 바꾸거나 실행설정을 저장해 돌고 있는 AIA와
   * 어긋나면, 그 대화를 정지·분리한 뒤 새 설정으로 다시 시작해야 한다.
   */
  const staleRuntime = aiaRuntimeNeedsRestart(session, provider, runtime);

  /**
   * 지금 대화를 화면에서 걷어 낸다. 새 대화 시작과 옛 실행설정 재시작이 각자 적던 순서 —
   * 붙어 있던 연결을 떼어 버리고, 세션·대화 기록·대기열을 비우고, 자동 시작 이펙트가
   * 뒤늦게 끼어들지 않게 이미 시작한 것으로 표시하는 것 — 은 두 갈래가 같으므로 여기 한
   * 벌로 둔다. 다음에 무엇을 할지(새로 시작이냐 복원이냐)는 걷어 낸 연결이 있었는지로
   * 갈리므로 그 연결을 그대로 돌려준다.
   *
   * 뗀 대화를 버릴 때는 다시 고르지 않도록 표시하고, 정지하고, 그 대화에 남은 알림까지
   * 걷는다. 알림을 남겨 두면 상단바 트리거가 팝업을 여는 대신 버린 대화로 전환해
   * (`toggleAia`), 새로 시작한 대화를 닫았다 열었을 때 이전 대화가 돌아온다.
   */
  const discardCurrentConversation = useCallback(async (): Promise<ChatConnection | null> => {
    const connection = takeConnection();
    if (connection) {
      discardedChatsRef.current.add(connection.info.chatId);
      await shutdownConnection(connection);
      onDiscardChat(connection.info.chatId);
    }
    setSession(null);
    setTurns([]);
    setQueue([]);
    autoStartedRef.current = true;
    return connection;
  }, [onDiscardChat, takeConnection]);

  /**
   * 어긋난 대화를 정지하고 새 설정으로 다시 시작한 뒤, 요청을 보낼 새 연결을 돌려준다.
   *
   * 이 일을 붙는 시점이 아니라 보내는 시점에 하는 이유는 채팅 런타임이 화면마다 구독을
   * 따로 갖기 때문이다. 보기는 병렬이지만 정지는 CLI 프로세스를 죽여 모든 화면에 적용되므로,
   * 붙는 즉시 정지하면 알림에서 옛 대화를 열어 본 화면 하나가 다른 창이 함께 보고 있던
   * 런타임까지 끊는다. 읽으려고 누른 내용이 그 자리에서 사라지는 것도 같은 이유였다.
   */
  const restartForStaleRuntime = useCallback(async (): Promise<ChatConnection | null> => {
    if (restartingRef.current) return null;
    restartingRef.current = true;
    try {
      activeTurnRef.current = null;
      await discardCurrentConversation();
      await restoreOrStartConversation();
      return connectionRef.current;
    } finally {
      restartingRef.current = false;
    }
  }, [connectionRef, discardCurrentConversation, restoreOrStartConversation]);

  const runSwitchConversation = useCallback(async (chatId: string): Promise<boolean> => {
    const connected = connectionRef.current;
    if (connected?.info.chatId === chatId) return true;

    const previousChatId = connected?.info.chatId ?? null;
    const generation = beginConversationAttempt();
    connectionRef.current = null;
    activeTurnRef.current = null;
    clearDraftAttachments();

    try {
      const outcome = await switchAttachedChat({
        detachPrevious: connected ? () => connected.detach() : null,
        attachNext: async () => claimConnection(generation, await attachChat(chatId, handleEventsForGeneration(generation))),
        reattachPrevious: previousChatId === null ? null : (async () => {
          const restoreGeneration = nextGeneration();
          const previous = await attachChat(previousChatId, handleEventsForGeneration(restoreGeneration));
          return claimConnection(restoreGeneration, previous);
        }),
      });
      if (outcome.ok) return outcome.switched;
      if (!outcome.restored) {
        setSession(null);
        setPhase("failed");
      }
      const prefix = outcome.restored ? text("기존 AIA 대화는 유지했지만 ", "The existing AIA conversation was kept, but ") : "";
      const reason = text("승인 요청 대화로 전환하지 못했습니다", "could not switch to the conversation awaiting approval");
      setError(`${prefix}${reason}: ${errorText(outcome.cause)}`);
      return false;
    } finally {
      endConversationAttempt();
    }
  }, [beginConversationAttempt, claimConnection, clearDraftAttachments, connectionRef, endConversationAttempt, handleEventsForGeneration, nextGeneration, text]);

  const switchConversation = useCallback(
    (chatId: string) => queueConversationWork(() => runSwitchConversation(chatId)),
    [queueConversationWork, runSwitchConversation],
  );

  useEffect(() => {
    if (!attentionTarget || handledAttentionRequestRef.current >= attentionTarget.requestId) return;
    const action = aiaAttentionTargetAction(open, providerConnected, starting);
    if (action === "wait") return;
    if (action === "reject") {
      // 팝업 본문이 CLI 연결 필요를 이미 안내하므로 대상만 실패로 소비한다(읽음 처리 없음).
      handledAttentionRequestRef.current = attentionTarget.requestId;
      onAttentionTargetHandled(attentionTarget, false);
      return;
    }
    // 전환을 걸기 전에 이 요청을 소비 처리한다. 결과를 기다리는 사이 `starting`이 바뀌면
    // 이 이펙트가 다시 도는데, 그때 같은 대상으로 전환을 또 걸면 붙기와 정지가 서로를
    // 다시 불러 끝나지 않는다. 요청 하나에 전환 하나, 그 결과가 곧 읽음 처리 근거다.
    handledAttentionRequestRef.current = attentionTarget.requestId;
    void switchConversation(attentionTarget.chatId)
      .then((opened) => onAttentionTargetHandled(attentionTarget, opened));
  }, [attentionTarget, onAttentionTargetHandled, open, providerConnected, starting, switchConversation]);

  // 새 응답이 흘러들어올 때 화면을 맨 아래에 붙여 둔다. 대화 화면과 같은 규칙을 쓰되,
  // 이 팝업에는 표시 위치 설정이 없어 맨 아래로 돌아오면 언제나 다시 따라간다.
  const { pause: pauseFollowingLatestMessages, resume: resumeFollowingLatestMessages } = useFollowLatestMessages({
    targetRef: streamRef,
    enabled: open,
    follow: true,
    resetKey: `${activeChatId ?? ""}:${open}`,
    growth: turns,
  });

  // 대화 안에서 찾기. 팝업은 대화 화면 위에 떠 있으므로 겹침 순서가 가장 높다 —
  // 팝업이 열려 있는 동안 Cmd+F는 뒤에 있는 대화 화면이 아니라 여기를 연다.
  const { findBar } = useChatFind({
    containerRef: streamRef,
    enabled: open,
    resetKey: activeChatId,
    priority: FIND_PRIORITY.aiaPopup,
  });

  // 읽던 자리. 대화 화면·세션 상세와 같은 훅을 쓰므로, 이 팝업에서 남긴 자리는 같은
  // 대화를 채팅 화면이나 세션 상세에서 열어도 그대로 보인다.
  const { controls: readingControls, captureReadingPoint } = useReadingBookmarks({
    containerRef: streamRef,
    source: session?.source ?? null,
    sessionId: session?.providerSessionId ?? null,
    resetKey: activeChatId,
  });

  // 링크 문서 미리보기가 이 팝업 위에 뜨면 Esc는 미리보기부터 닫는다(useEscapeToClose가 겹침 순서를 지킨다).
  useEscapeToClose(onClose, open);

  const closeLinkedFilePreview = linkedFilePreview.close;
  useEffect(() => {
    if (!open) closeLinkedFilePreview();
  }, [closeLinkedFilePreview, open]);

  useEffect(() => () => {
    void detachQuietly(takeConnection());
  }, [takeConnection]);

  // 승인 대기는 사용자를 기다리는 멈춤 상태라 "진행 중"에서 뺀다. 그쪽은 알림(attention)이 맡는다.
  useEffect(() => { onBusyChange(phase === "running"); }, [onBusyChange, phase]);
  useEffect(() => () => { onBusyChange(false); }, [onBusyChange]);

  // 예전 실행설정으로 시작한 대화에 요청을 보내려 할 때 할 일. 사용자가 쓴 메시지와 앱이
  // 자동으로 보내는 요청 모두 이 판단을 지나야 옛 설정 런타임으로 새 요청이 가지 않는다.
  const staleSendAction = aiaStaleSendAction(staleRuntime, phase);
  const staleRuntimeNotice = !staleRuntime
    ? null
    : staleSendAction === "blocked"
      ? text(
        "실행설정이 바뀌었습니다. 진행 중인 작업이 끝나거나 중단된 뒤 보내면 새 설정으로 새 대화를 시작합니다.",
        "The execution settings changed. Once the running task finishes or stops, sending starts a new conversation with the new settings.",
      )
      : composerUsable
        ? text(
          "예전 실행설정으로 시작한 대화입니다. 보내면 이 대화를 정지하고 새 설정으로 새 대화를 시작합니다.",
          "This conversation started with the previous execution settings. Sending stops it and starts a new conversation with the new settings.",
        )
        : text(
          "예전 실행설정으로 시작한 대화입니다. 새 설정은 대화를 새로 시작할 때 적용됩니다.",
          "This conversation started with the previous execution settings. The new settings apply when a new conversation starts.",
        );
  const pendingApprovals = useMemo(() => pendingChatApprovals(turns), [turns]);

  useEffect(() => {
    if (
      !open ||
      !autoPrompt ||
      handledAutoPromptRef.current >= autoPrompt.requestId
    ) return;
    if (!providerConnected) {
      handledAutoPromptRef.current = autoPrompt.requestId;
      onAutoPromptHandled(autoPrompt, false);
      return;
    }
    const connection = connectionRef.current;
    if (!connection) {
      // 최초 자동 시작 이펙트가 돌지 않은 경우(이전 시작 실패 등)에만 직접 복구한다.
      if (!startingRef.current && autoStartedRef.current) void restoreOrStartConversation();
      return;
    }
    if (!composerUsable) return;
    // 앱이 보내는 요청도 옛 설정 런타임에는 넣지 않는다. 다시 시작해 두면 새 연결이 준비된
    // 뒤 이 이펙트가 다시 돌아 보낸다(요청은 아직 소비하지 않는다). 턴이 도는 중이면
    // 끊을 수 없으므로, 턴이 끝나 상태 이벤트가 올 때까지 그대로 기다린다.
    if (staleSendAction === "blocked") return;
    if (staleSendAction === "restart") {
      void restartForStaleRuntime();
      return;
    }
    handledAutoPromptRef.current = autoPrompt.requestId;
    void connection.send(autoPrompt.text)
      .then(() => onAutoPromptHandled(autoPrompt, true))
      .catch((cause) => {
        setError(errorText(cause));
        onAutoPromptHandled(autoPrompt, false);
      });
  }, [autoPrompt, composerUsable, onAutoPromptHandled, open, phase, providerConnected, restartForStaleRuntime, restoreOrStartConversation, staleSendAction]);

  /**
   * 작성창이 지금 보낼 수 있는지와, 옛 실행설정 대화일 때 할 일은 대화 쪽 사정이다.
   * 작성창 훅은 그 판단을 스스로 하지 않고 보낼 때마다 넘겨받는다.
   */
  const deliverComposer = (deliverNow: boolean) => draft.deliver(deliverNow, {
    staleAction: staleSendAction,
    staleNotice: staleRuntimeNotice,
    restart: restartForStaleRuntime,
  });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    // 답변을 읽다 말고 새 요청을 보내면 응답을 따라 화면이 아래로 내려간다. 보내기
    // 직전의 자리를 챙겨 두어야 '읽던 곳으로'가 그 자리를 되살릴 수 있다.
    captureReadingPoint();
    await deliverComposer(false);
  };

  /** 지금 붙어 있는 연결에 한 동작을 건다. 연결이 없을 때의 처리와 오류 표시는 셋이 같다. */
  const runConnectionAction = (action: (connection: ChatConnection) => Promise<unknown>) =>
    runChatConnectionAction(connectionRef.current, action, setError);

  const decide = async (approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>, secret?: string, saveSecret?: boolean) => {
    setError(null);
    await runConnectionAction((connection) => connection.approve(approvalId, decision, answers, secret, saveSecret));
  };

  const removeQueued = async (messageId: string) => {
    await runConnectionAction((connection) => connection.removeQueued(messageId));
  };

  const newConversation = async () => {
    const connection = await discardCurrentConversation();
    draft.clear();
    // 연결이 없던 상태(시작 실패 후 재시도)라면 백엔드에 남아 있는 AIA 대화 복원을 먼저 시도한다.
    if (connection) await startConversation();
    else await restoreOrStartConversation();
  };

  const interrupt = async () => {
    await runConnectionAction((connection) => connection.interrupt());
  };

  return (
    <aside className={`aia-chat-popup${open ? " open" : ""}${yieldForGuide ? " guide-yield" : ""}${windowId ? " standalone" : ""}`} role="dialog" aria-label={text("AIA 시스템 에이전트", "AIA system agent")} aria-hidden={!open} {...draft.dropZone.dropProps}>
      {draft.dropZone.over && <FileDropOverlay />}
      <header className="aia-chat-header">
        <div className="aia-avatar"><AiaMark size={24} /></div>
        <div><strong>AIA</strong><small><i className={`terminal-status terminal-status-${phase}`} />Agent Manager ({providerName})</small></div>
        <div className="aia-header-actions">
          <button type="button" title={text("새 AIA 팝업창 열기", "Open a new AIA popup window")} aria-label={text("새 AIA 팝업창 열기", "Open a new AIA popup window")} onClick={() => {
            void openPopoutWindow({ kind: "aia", windowId: crypto.randomUUID() }).catch((cause) => setError(errorText(cause)));
          }}><ExternalLink size={15} /></button>
          {providerConnected && <button type="button" onClick={() => void newConversation()} disabled={starting} title={session ? text("새 AIA 대화", "New AIA conversation") : text("AIA 다시 시작", "Restart AIA")}><RefreshCw size={15} /></button>}
          <button type="button" onClick={onClose} title={text("AIA 닫기", "Close AIA")}><X size={17} /></button>
        </div>
      </header>

      <AiaSuggestionDock suggestions={suggestions} onDismiss={onDismissSuggestion} onInsertPrompt={insertPrompt} />
      {!providerConnected ? (
        <AiaConnectPanel
          providerName={providerName}
          composerRef={draft.inputRef}
          composer={composer}
          onComposerChange={setComposer}
          onConnectProvider={onConnectProvider}
        />
      ) : (
        <>
          <AiaConversationStream
            streamRef={streamRef}
            overlay={findBar}
            providerName={providerName}
            systemTools={session ? session.systemTools : supportsAiaSystemTools(provider)}
            starting={starting}
            turns={turns}
            chatId={session?.chatId ?? null}
            error={error}
            readingControls={readingControls}
            onDecision={decide}
            onOpenLocalLink={linkedFilePreview.open}
            onInsertPrompt={insertPrompt}
            onScrollAwayFromLatest={pauseFollowingLatestMessages}
            onScrollToLatest={resumeFollowingLatestMessages}
          />
          {staleRuntimeNotice && <p className="aia-runtime-restart-notice" role="status">{staleRuntimeNotice}</p>}
          <ChatApprovalDock
            className="aia-approval-dock"
            label={text("시스템 기능 승인 대기", "Awaiting system capability approval")}
            title={text("시스템 기능 승인", "System capability approval")}
            hint={text("검토 후 허용하세요.", "Review before allowing.")}
            prompts={pendingApprovals}
            onDecision={decide}
          />
          <ChatQueueList items={queue} onRemove={(id) => void removeQueued(id)} onRecall={(item) => { void removeQueued(item.id); draft.recallQueued(item.text, queuedAttachmentsToDrafts(item.attachments, session?.chatId ?? null)); }} />
          <AiaComposer
            inputRef={draft.inputRef}
            value={composer}
            attachments={attachments}
            uploading={draft.uploading}
            usable={composerUsable}
            busy={busy}
            waitingApproval={phase === "waitingApproval"}
            canDeliver={supportsDeliveryDuringTurn(session?.source ?? provider)}
            onChange={setComposer}
            onAddFiles={draft.addFiles}
            onRemoveAttachment={draft.removeAttachment}
            onSubmit={send}
            onQueue={() => void deliverComposer(false)}
            onDeliver={() => void deliverComposer(true)}
            onInterrupt={() => void interrupt()}
          />
        </>
      )}
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </aside>
  );
}

/** AIA 작성창의 입력·첨부와 응답 중 전송 선택 상태를 한 자리에서 관리한다. */
/** 보낼 때마다 대화 쪽에서 넘겨받는 판단. 작성창은 실행설정을 스스로 읽지 않는다. */
interface AiaDeliveryPolicy {
  staleAction: ReturnType<typeof aiaStaleSendAction>;
  staleNotice: string | null;
  /** 옛 실행설정 대화를 정지하고 새 설정으로 다시 시작해 새 연결을 돌려준다. */
  restart: () => Promise<ChatConnection | null>;
}

/**
 * AIA 작성창이 홀로 쓰는 상태 — 쓰던 글, 담아 둔 첨부, 업로드 중 여부와 그것들을 옮기는
 * 손잡이를 한 자리에 모은다. 대화 연결·세대·실행설정은 팝업 본체가 맡고, 여기서는 보낼
 * 때마다 `AiaDeliveryPolicy`로 넘겨받기만 한다.
 */
function useAiaComposerDraft({ connectionRef, providerConnected, usable, onError }: {
  connectionRef: MutableRefObject<ChatConnection | null>;
  providerConnected: boolean;
  /** 이 대화에 지금 요청을 보낼 수 있는지. 보내기와 되돌아오는 초점이 이 값을 따른다. */
  usable: boolean;
  onError: (message: string | null) => void;
}) {
  const { text } = useI18n();
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingFocusRef = useRef(false);

  const focusAtEnd = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea || textarea.disabled) return;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    pendingFocusRef.current = false;
  }, []);

  const insertPrompt = useCallback((prompt: string) => {
    setComposer((current) => mergeComposerDraft(current, prompt));
    pendingFocusRef.current = true;
    window.requestAnimationFrame(() => { focusAtEnd(); });
  }, [focusAtEnd]);

  const addFiles = (files: File[]) => {
    // 이 배너는 연결·전송 오류와 같은 자리라, 첨부가 성공했다고 남의 오류까지 지우지 않는다.
    setAttachments((current) => addAttachmentDrafts(current, files, (message) => {
      if (message !== null) onError(message);
    }));
  };

  // 팝업 어디에 놓아도 첨부로 들어간다 — 채팅 화면·세션 상세와 같은 규칙. 대화가 아직
  // 시작되지 않았거나 멈춰 있어도 담아 두었다가 첫 메시지에 실어 보낸다(첨부는 보낼 때
  // 올라간다). 공급자에 연결되기 전에는 작성창 자리에 연결 안내가 들어와 담긴 파일을
  // 보여 줄 자리가 없으므로 그때만 받지 않는다.
  const dropZone = useFileDropZone(addFiles, !providerConnected || uploading, onError);

  const removeAttachment = (target: ChatAttachmentDraft) => {
    setAttachments((current) => current.filter((item) => item.key !== target.key));
    releaseAttachmentDraftUpload(target, connectionRef.current?.info.chatId);
  };

  /** deliverNow면 응답 중에도 중단 없이 진행 중인 작업에 바로 전달한다. */
  const deliver = async (deliverNow: boolean, policy: AiaDeliveryPolicy) => {
    // 보낼 글은 `body`로 받는다 — 이 자리의 `text`는 문구 짝을 고르는 함수다.
    const body = composer.trim();
    if ((!body && attachments.length === 0) || uploading) return;
    // 쓴 글이 있는데 보낼 길이 없으면 이유를 남긴다. 조용히 돌아가면 사용자에게는
    // 버튼이 먹지 않는 것과 구분되지 않는다.
    if (!connectionRef.current || !usable) {
      onError(text(
        "AIA에 연결되어 있지 않아 메시지를 보내지 못했습니다. 팝업을 닫았다 다시 열어 주세요.",
        "The message was not sent because AIA is not connected. Close the popup and open it again.",
      ));
      return;
    }
    if (policy.staleAction === "blocked") {
      onError(policy.staleNotice);
      return;
    }
    onError(null);
    setUploading(true);
    try {
      let connection = connectionRef.current;
      let drafts = attachments;
      if (policy.staleAction === "restart") {
        // 첨부는 대화별로 올라가므로 업로드보다 정지·재시작을 먼저 끝낸다.
        const moved = movableAttachmentDrafts(attachments);
        const restarted = await policy.restart();
        if (!restarted) {
          onError(text(
            "새 실행설정으로 AIA를 다시 시작하지 못해 메시지를 보내지 못했습니다.",
            "The message was not sent because AIA could not restart with the new execution settings.",
          ));
          return;
        }
        connection = restarted;
        drafts = moved.drafts;
        setAttachments(moved.drafts);
        if (moved.dropped > 0) {
          onError(text(
            `옛 대화에 올려 둔 첨부 ${moved.dropped}개는 새 대화로 옮기지 못해 제외했습니다.`,
            `${moved.dropped} attachment(s) uploaded to the previous conversation could not be moved and were dropped.`,
          ));
        }
      }
      await sendWithAttachmentDrafts(connection, body, drafts, setAttachments, {
        // 새로 시작한 대화에는 끼어들 작업이 없다.
        steer: deliverNow && policy.staleAction === "send",
      });
      setComposer("");
      setAttachments([]);
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (!pendingFocusRef.current || !usable) return;
    const frame = window.requestAnimationFrame(() => { focusAtEnd(); });
    return () => window.cancelAnimationFrame(frame);
  }, [composer, focusAtEnd, usable]);

  const clearAttachments = useCallback(() => setAttachments([]), []);

  return {
    composer,
    setComposer,
    attachments,
    uploading,
    inputRef,
    dropZone,
    addFiles,
    removeAttachment,
    insertPrompt,
    deliver,
    /** 대기열에서 되돌린 메시지를 작성창으로 되돌려 놓는다. */
    recallQueued: (text: string, drafts: ChatAttachmentDraft[]) => {
      setComposer(text);
      setAttachments((current) => [...current, ...drafts]);
    },
    clearAttachments,
    clear: () => { setComposer(""); setAttachments([]); },
  };
}

function AiaComposer({
  inputRef,
  value,
  attachments,
  uploading,
  usable,
  busy,
  waitingApproval,
  canDeliver,
  onChange,
  onAddFiles,
  onRemoveAttachment,
  onSubmit,
  onQueue,
  onDeliver,
  onInterrupt,
}: ChatComposerDraftHandles & {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  usable: boolean;
  waitingApproval: boolean;
}) {
  const { text } = useI18n();
  const { hasDraft, sendMenuActive, setSendMenuOpen } = useComposerSendState({ value, attachments, busy });
  return <form className="aia-composer" onSubmit={onSubmit}>
    <AiaComposerTextarea
      inputRef={inputRef}
      value={value}
      onChange={onChange}
      onKeyDown={submitComposerOnEnter}
      onPaste={attachPastedFiles(onAddFiles)}
      rows={1}
      placeholder={waitingApproval
        ? text("승인 대기 중입니다", "Waiting for approval")
        : busy
          ? text("응답 중 · 전송하면 대기열에 추가됩니다", "Responding · sending adds to the queue")
          : text("AIA에게 질문하세요", "Ask AIA")}
      disabled={!usable}
    />
    <VoiceInputControl value={value} disabled={!usable || uploading} onChange={onChange} />
    <AttachmentPicker drafts={attachments} disabled={!usable || uploading} onAdd={onAddFiles} onRemove={onRemoveAttachment} />
    {sendMenuActive && hasDraft ? <ChatSendActionMenu
      hasDraft={hasDraft}
      sendDisabled={uploading}
      canDeliver={canDeliver}
      trigger={{ className: "aia-send", title: uploading ? "첨부 중…" : text("보낼 방법 고르기", "Choose how to send"), content: <Send size={16} /> }}
      onOpenChange={setSendMenuOpen}
      onQueue={onQueue}
      onDeliver={onDeliver}
      onInterrupt={onInterrupt}
    /> : busy ? <button className="aia-stop" type="button" onClick={onInterrupt} title={text("현재 응답 중단", "Stop the current response")}><Square size={14} /></button> : <button className="aia-send" type="submit" disabled={!usable || uploading || !hasDraft} title={uploading ? "첨부 중…" : "전송"}><Send size={16} /></button>}
  </form>;
}

/**
 * AIA 입력창. 연결 전 초안 자리와 대화 중 작성 자리가 같은 입력을 공유하므로 —
 * 같은 ref·같은 값·같은 갱신 경로 — 두 자리가 갈라지지 않도록 여기 한 곳에 둔다.
 */
function AiaComposerTextarea({ inputRef, value, onChange, rows, placeholder, disabled = false, onKeyDown, onPaste }: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder: string;
  disabled?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
}) {
  const { text } = useI18n();
  return <textarea
    ref={inputRef}
    aria-label={text("AIA 메시지 입력", "AIA message input")}
    value={value}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={onKeyDown}
    onPaste={onPaste}
    rows={rows}
    placeholder={placeholder}
    disabled={disabled}
  />;
}

/** 감지된 사건을 명령 초안으로 건네는 제안 카드 묶음. 최대 세 장만 세우고 나머지는 개수로 알린다. */
function AiaSuggestionDock({ suggestions, onDismiss, onInsertPrompt }: {
  suggestions: AiaSuggestion[];
  onDismiss: (suggestion: AiaSuggestion) => void;
  onInsertPrompt: (prompt: string) => void;
}) {
  const { text } = useI18n();
  if (suggestions.length === 0) return null;
  return <section className="aia-suggestion-dock" aria-label={text("AIA 제안", "AIA suggestions")}>
    <header><strong>{text("먼저 확인해 보세요", "Check these first")}</strong>{suggestions.length > 3 && <span>외 {suggestions.length - 3}개</span>}</header>
    {suggestions.slice(0, 3).map((suggestion) => <AiaSuggestionCard
      suggestion={suggestion}
      onDismiss={onDismiss}
      onInsertPrompt={onInsertPrompt}
      key={suggestion.fingerprint}
    />)}
  </section>;
}

/** 제안 한 건의 설명과 초안·숨김 액션. 목록의 제한·순서는 위 Dock이 맡는다. */
function AiaSuggestionCard({ suggestion, onDismiss, onInsertPrompt }: {
  suggestion: AiaSuggestion;
  onDismiss: (suggestion: AiaSuggestion) => void;
  onInsertPrompt: (prompt: string) => void;
}) {
  const { text } = useI18n();
  return <article className={`aia-suggestion-card ${suggestion.severity}`}>
    <div><small>{suggestion.packDisplayName}</small><strong>{suggestion.title}</strong><p>{suggestion.detail}</p></div>
    <div className="aia-suggestion-actions">
      <button type="button" onClick={() => onDismiss(suggestion)} title={text("이 제안 숨기기", "Hide this suggestion")}>숨기기</button>
      <button className="primary" type="button" onClick={() => onInsertPrompt(suggestion.prompt)}>{text("명령 입력", "Insert command")}</button>
    </div>
  </article>;
}

/** 시스템 에이전트 공급자가 아직 연결되지 않았을 때의 안내. 초안은 여기서도 쓸 수 있게 둔다. */
function AiaConnectPanel({ providerName, composerRef, composer, onComposerChange, onConnectProvider }: {
  providerName: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  composer: string;
  onComposerChange: (value: string) => void;
  onConnectProvider: () => void;
}) {
  const { text } = useI18n();
  return <div className="aia-unavailable">
    <AiaMark size={34} />
    <strong>{text(
      `AIA를 시작하려면 ${providerName} CLI 연결이 필요합니다.`,
      `Connect the ${providerName} CLI to start AIA.`,
    )}</strong>
    <small>{text(
      "설정 > AIA 설정에서 다른 공급자를 고를 수도 있습니다.",
      "You can also pick another provider in Settings > AIA settings.",
    )}</small>
    <button className="button primary" type="button" onClick={onConnectProvider}>{providerName} 연결</button>
    <AiaComposerTextarea
      inputRef={composerRef}
      value={composer}
      onChange={onComposerChange}
      rows={3}
      placeholder={text("제안 명령을 선택하면 여기에 초안으로 추가됩니다", "Selected suggestion commands are added here as a draft")}
    />
    {composer && <small>{text(
      "초안은 연결 후에도 유지되며 자동 전송되지 않습니다.",
      "The draft is kept after connecting and is never sent automatically.",
    )}</small>}
  </div>;
}

/** 인사말·연결 표시·턴 목록·오류를 담은 대화 흐름과 그 스크롤 조작. */
function AiaConversationStream({ streamRef, providerName, systemTools, starting, turns, chatId, error, readingControls, overlay, onDecision, onOpenLocalLink, onInsertPrompt, onScrollAwayFromLatest, onScrollToLatest }: {
  streamRef: RefObject<HTMLDivElement | null>;
  providerName: string;
  systemTools: boolean;
  starting: boolean;
  turns: ChatTurn[];
  chatId: string | null;
  error: string | null;
  /** 읽던 자리 버튼 묶음. 스크롤 조작 묶음 맨 위에 함께 선다. */
  readingControls: (scrollable: boolean) => ReactNode;
  /** 대화 위에 떠 있는 것(찾기 막대). 흐름에 끼우면 열 때마다 대화가 아래로 밀린다. */
  overlay?: ReactNode;
  onInsertPrompt: (prompt: string) => void;
  onScrollAwayFromLatest: () => void;
  onScrollToLatest: () => void;
} & ChatEntryActions) {
  const { text } = useI18n();
  return <div className="aia-chat-stream-shell">
    <div className="aia-chat-stream" aria-live="polite" ref={streamRef}>
      <article className="aia-welcome">
        <strong>{text("안녕하세요, AIA입니다.", "Hello, this is AIA.")}</strong>
        <p>{text(
          "Agent Manager의 상태를 확인하거나 작업요청·설정변경·세션확인·반복 요청 작성 등 작업명령을 요청할 수 있습니다.",
          "Ask about Agent Manager's status, or give commands such as requesting work, changing settings, checking sessions, and writing recurring requests.",
        )}</p>
        {!systemTools && <p className="aia-capability-warning" role="status">{text(
          `${providerName} CLI는 실행 단위 MCP 설정을 제공하지 않아 이 런타임에서는 시스템 도구를 쓸 수 없습니다. 설정·세션을 직접 조작하려면 시스템 설정에서 Codex 또는 Claude를 고르세요.`,
          `The ${providerName} CLI offers no per-run MCP configuration, so system tools are unavailable in this runtime. To operate settings and sessions directly, pick Codex or Claude as the system agent.`,
        )}</p>}
      </article>
      {starting && turns.length === 0 && <div className="aia-connecting"><span className="spin">◌</span> {text("시스템 인터페이스 연결 중…", "Connecting to the system interface…")}</div>}
      {turns.map((turn) => <AiaTurnView turn={turn} chatId={chatId} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} onInsertPrompt={onInsertPrompt} key={turn.id} />)}
      {error && <ErrorBanner message={error} />}
    </div>
    <ChatScrollControls
      targetRef={streamRef}
      leading={readingControls}
      onScrollAwayFromLatest={onScrollAwayFromLatest}
      onScrollToLatest={onScrollToLatest}
    />
    {overlay}
  </div>;
}

function AiaTurnView({ turn, chatId, onDecision, onOpenLocalLink, onInsertPrompt }: { turn: ChatTurn; chatId: string | null; onInsertPrompt?: (prompt: string) => void } & ChatEntryActions) {
  const { text } = useI18n();
  return <ChatTurnSegments
    turn={turn}
    className="aia-turn"
    renderEntry={(entry, { copyReady, completedFinal, speechReady }) =>
      <AiaEntryView entry={entry} chatId={chatId} copyReady={copyReady} speechReady={speechReady} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} onInsertPrompt={completedFinal ? onInsertPrompt : undefined} />}
    // 머리줄은 진행 중·완료 두 마디로만 적고 진행 시간은 붙이지 않는다.
    describeActivity={(logged, { active, isLastActivity }) => ({
      status: active ? "running" : isLastActivity ? turn.status : "completed",
      statusText: active ? text("작업 중", "Working") : text("완료", "Complete"),
      summary: activitySummary(logged, text),
    })}
    renderActivityEntry={(entry, { running }) =>
      <AiaEntryView entry={entry} chatId={chatId} copyReady={!running} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />}
  />;
}

function AiaEntryView({ entry, chatId, copyReady, speechReady = false, onDecision, onOpenLocalLink, onInsertPrompt }: { entry: ChatEntry; chatId: string | null; copyReady: boolean; speechReady?: boolean; onInsertPrompt?: (prompt: string) => void } & ChatEntryActions) {
  const { text } = useI18n();
  if (entry.type === "message") {
    // AIA는 공급자 메타 블록을 붙이지 않으므로 본문을 그대로 쓰고 메타 칸도 비운다.
    return <ChatMessageArticle
      entry={entry}
      chatId={chatId}
      copyReady={copyReady}
      speechReady={speechReady}
      text={entry.text}
      label={entry.kind === "reasoning" ? text("AIA 작업", "AIA work") : entry.role === "user" ? text("사용자", "User") : "AIA"}
      speechIdPrefix="aia:"
      // 읽던 자리가 짚을 열쇠. 대화 화면과 같은 값을 적는다 — 빼 두면 이 팝업에는
      // `data-message-key`가 하나도 없어, 책갈피가 늘 "표시할 자리를 찾지 못했습니다"로
      // 끝나고 되돌아가기 버튼도 뜨지 않았다.
      messageKey={liveMessageKey(entry.id, entry.kind)}
      onOpenLocalLink={onOpenLocalLink}
      onInsertPrompt={onInsertPrompt}
    />;
  }
  // 도구·승인·오류 카드는 일반 대화와 같은 것을 세운다. AIA만 다른 것은 메시지뿐이다.
  return <ChatEntryView entry={entry} chatId={chatId} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />;
}

/** 문구 함수는 호출부에서 넘겨받는다 — 이 자리는 컴포넌트가 아니라 훅을 부를 수 없다. */
function activitySummary(entries: ChatActivityEntry[], text: UiText): string {
  const { tools } = chatActivityCounts(entries);
  return tools > 0
    ? text(`시스템 도구 ${tools}개`, `${tools} system tool(s)`)
    : text("AIA 진행 상황", "AIA progress");
}
