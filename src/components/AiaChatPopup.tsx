import { Fragment, type ClipboardEventHandler, type FormEvent, type KeyboardEventHandler, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Send, Square, X } from "lucide-react";
import { attachChat, connectChat, supportsDeliveryDuringTurn, type ChatConnection } from "../lib/chat";
import {
  addAttachmentDrafts,
  AttachmentPicker,
  ChatAttachmentList,
  clipboardFiles,
  queuedAttachmentsToDrafts,
  releaseAttachmentDraftUpload,
  uploadAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import {
  isRunningTurn,
  segmentChatTimeline,
  updateChatTurnEntries,
  upsertChatTurnState,
  type ChatTimelineTurn,
} from "../lib/chatTimeline";
import { enableAiaWindowSessions, rememberAiaWindowSession, selectAiaWindowSession } from "../lib/aiaWindowSession";
import { openPopoutWindow } from "../lib/popoutWindow";
import { submitComposerOnEnter } from "../lib/composerKeys";
import { collectChatSkillUsages, isSkillUsageEntry } from "../lib/skillUsage";
import { aiaChatsForProvider, aiaRuntimeNeedsRestart, supportsAiaSystemTools, type AiaRuntimeSettings } from "../lib/aiaRuntime";
import { aiaAttentionTargetAction } from "../lib/aiaAttention";
import { downloadChatLinkedFile, getChatLinkedFile, getLiveChats } from "../lib/ipc";
import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatInputFile,
  ChatPhase,
  ChatSessionInfo,
  ProviderId,
  QueuedChatMessage,
} from "../types";
import { ChatActivityGroup } from "./ChatActivityGroup";
import { ChatSkillUsageCard } from "./ChatSkillUsage";
import { ChatToolCard } from "./ChatToolCard";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { CopyAction } from "./CopyAction";
import { ChatScrollControls } from "./ChatConversation";
import { SpeechPlaybackAction, VoiceInputControl } from "./VoiceControls";
import { isReadableFinalResponse } from "../lib/voice";
import { mergeComposerDraft, type AiaSuggestion } from "../lib/aiaSuggestions";
import { errorText } from "../lib/errorText";
import {
  AiaMark,
  ChatApprovalCard,
  ChatApprovalDock,
  ChatQueueList,
  ChatSendActionMenu,
  ErrorBanner,
  useEscapeToClose,
  type ChatApprovalPrompt,
} from "./Shared";

type AiaEntry =
  | { type: "message"; id: string; role: string; kind: string; text: string; attachments: ChatInputFile[] }
  | { type: "tool"; id: string; name: string; status: string; detail: string; output: string }
  | ({ type: "approval" } & ChatApprovalPrompt)
  | { type: "error"; id: string; text: string };

type AiaTurn = ChatTimelineTurn<AiaEntry>;
type AiaActivityEntry = Extract<AiaEntry, { type: "tool" }> | Extract<AiaEntry, { type: "message" }>;
/** 붙기 결과. stale은 뒤에 시작된 작업이 화면을 맡아 이 연결을 버렸다는 뜻이다. */
type AiaAttachResult = "attached" | "failed" | "stale";

interface AiaChatPopupProps {
  windowId?: string | null;
  open: boolean;
  /** 시스템 설정에서 고른 시스템 에이전트. AIA 런타임이 이 공급자로 실행된다. */
  provider: ProviderId;
  /**
   * 설정 화면에 저장된 이 공급자의 AIA 실행설정. 백엔드가 AIA를 시작할 때 쓰는 값과 같으며,
   * 저장본이 바뀌면 돌던 대화를 정지하고 새 설정으로 다시 시작하는 근거가 된다.
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
  /** 팝업이 닫혀 있어도 상단바 트리거가 진행 중 표시를 켤 수 있도록 실행 상태를 알린다. */
  onBusyChange: (busy: boolean) => void;
  /** AIA가 show_ui_guide로 보낸 화면 안내를 앱에 넘긴다. false가 오면 대상을 화면에서 찾지 못한 것이다. */
  onUiGuide: (event: Extract<ChatEvent, { type: "uiGuide" }>) => Promise<boolean>;
  /** AIA가 find_ui_elements로 보낸 요소 조회. 앱이 화면을 스캔해 answer_ui_query로 답한다. */
  onUiQuery: (event: Extract<ChatEvent, { type: "uiQuery" }>) => void;
  /** AIA가 open/click_ui_element로 보낸 클릭 요청. 앱이 아이아 커서를 움직여 누르고 결과를 답한다. */
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

export function AiaChatPopup({ open, provider, runtime, providerName, providerConnected, attentionTarget, autoPrompt, suggestions, onClose, onConnectProvider, onAttentionTargetHandled, onAutoPromptHandled, onDismissSuggestion, onBusyChange, onUiGuide, onUiQuery, onUiClick, yieldForGuide = false, windowId = null }: AiaChatPopupProps) {
  const [session, setSession] = useState<ChatSessionInfo | null>(null);
  const [phase, setPhase] = useState<ChatPhase | "connecting">("connecting");
  const [turns, setTurns] = useState<AiaTurn[]>([]);
  const [queue, setQueue] = useState<QueuedChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const connectionRef = useRef<ChatConnection | null>(null);
  const generationRef = useRef(0);
  // AIA 연결 작업(복원·시작·전환)을 순서대로 처리하기 위한 꼬리 promise.
  const conversationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activeTurnRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const restartingRef = useRef(false);
  const handledAutoPromptRef = useRef(0);
  const streamRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const pendingComposerFocusRef = useRef(false);
  const followLatestMessagesRef = useRef(true);

  const applySession = useCallback((next: ChatSessionInfo) => {
    try { rememberAiaWindowSession(window.localStorage, window.sessionStorage, windowId, next.chatId); } catch { /* 저장이 막혀도 현재 연결은 유지한다. */ }
    setSession(next);
    setPhase(next.state);
  }, [windowId]);

  /**
   * 새 연결 시도가 화면을 맡는다. 세대를 올려 앞선 시도의 이벤트를 버리게 하고 지난 대화의
   * 잔상을 지운 뒤, 이 시도가 자기 이벤트인지 가릴 때 쓸 세대를 돌려준다.
   */
  const beginConversationAttempt = useCallback((): number => {
    startingRef.current = true;
    setStarting(true);
    setError(null);
    setTurns([]);
    setQueue([]);
    setPhase("connecting");
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  const endConversationAttempt = useCallback(() => {
    startingRef.current = false;
    setStarting(false);
  }, []);

  /**
   * 붙는 데 성공한 연결을 화면에 싣는다. 그 사이 뒤에 시작된 작업이 화면을 맡았으면 이
   * 연결의 이벤트는 세대 검사에서 버려지므로 붙이지 않고 정리하고 false를 돌려준다.
   * 백엔드에 남는 실행은 다음 복원이 다시 찾아 붙는다.
   */
  const claimConnection = useCallback(async (generation: number, connection: ChatConnection): Promise<boolean> => {
    if (generation !== generationRef.current) {
      await connection.detach().catch(() => undefined);
      return false;
    }
    connectionRef.current = connection;
    applySession(connection.info);
    return true;
  }, [applySession]);

  /**
   * 지금 붙어 있는 연결을 화면에서 뗀다. 세대를 올려 이 연결에서 뒤늦게 오는 이벤트를
   * 버리게 하고 참조를 비운 뒤, 정리할 연결을 돌려준다.
   */
  const takeConnection = useCallback((): ChatConnection | null => {
    generationRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    return connection;
  }, []);

  const activeChatId = session?.chatId ?? null;
  const loadLinkedFile = useCallback((href: string) => {
    if (!activeChatId) return Promise.reject(new Error("연결된 AIA 대화를 찾을 수 없습니다."));
    return getChatLinkedFile(activeChatId, href);
  }, [activeChatId]);
  const downloadLinkedFile = useCallback((href: string) => {
    if (!activeChatId) return Promise.reject(new Error("연결된 AIA 대화를 찾을 수 없습니다."));
    return downloadChatLinkedFile(activeChatId, href);
  }, [activeChatId]);
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);

  const handleEvent = useCallback((event: ChatEvent) => {
    if (event.type === "replayReset") {
      activeTurnRef.current = null;
      setTurns([]);
      return;
    }
    if (event.type === "state") {
      applySession(event.session);
      return;
    }
    if (event.type === "queue") {
      setQueue(event.items);
      return;
    }
    if (event.type === "turn") {
      if (event.status === "started") activeTurnRef.current = event.id;
      setTurns((current) => upsertChatTurnState(current, event));
      if (event.status !== "started" && activeTurnRef.current === event.id) {
        activeTurnRef.current = null;
      }
      return;
    }
    if (event.type === "uiGuide") {
      // 대화 목록에는 넣지 않는다. 화면의 화살표가 곧 이 이벤트의 표시다.
      void onUiGuide(event).then((shown) => {
        if (shown) return;
        const subject = event.target ?? event.element?.text ?? event.element?.ref ?? "?";
        setError(`화면에서 안내할 위치를 찾지 못했습니다: ${subject}`);
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
    const turnId = activeTurnRef.current ?? "system";
    if (event.type === "messageDelta") {
      setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => upsertMessage(entries, event)));
      return;
    }
    if (event.type === "userInput") {
      setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => [
        ...entries,
        { type: "message", id: event.id, role: "user", kind: "message", text: event.text, attachments: event.attachments },
      ]));
      return;
    }
    if (event.type === "tool") {
      setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => upsertTool(entries, event)));
      return;
    }
    if (event.type === "approval") {
      setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => [
        ...entries,
        {
          type: "approval",
          id: event.id,
          kind: event.kind,
          questions: event.questions ?? [],
          title: event.title,
          detail: event.detail ?? "",
          options: event.options,
          interactive: event.interactive,
          resolved: null,
          answers: {},
        },
      ]));
      return;
    }
    if (event.type === "approvalResolved") {
      setTurns((current) => current.map((turn) => ({
        ...turn,
        entries: turn.entries.map((entry) => entry.type === "approval" && entry.id === event.id
          ? { ...entry, resolved: event.decision, answers: event.answers ?? {} }
          : entry),
      })));
      return;
    }
    if (event.type === "takenOver") {
      setError("다른 화면에서 이 채팅에 연결되어 이 화면의 실시간 연결이 해제되었습니다.");
      return;
    }
    if (event.type === "error") {
      setError(event.message);
      setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => [
        ...entries,
        { type: "error", id: crypto.randomUUID(), text: event.message },
      ]));
    }
  }, [applySession, onUiClick, onUiGuide, onUiQuery]);

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
      }, (event) => {
        if (generation === generationRef.current) handleEvent(event);
      });
      await claimConnection(generation, connection);
    } catch (cause) {
      setSession(null);
      setError(errorText(cause));
      setPhase("failed");
    } finally {
      endConversationAttempt();
    }
  }, [beginConversationAttempt, claimConnection, endConversationAttempt, handleEvent, provider, providerConnected]);

  const attachConversation = useCallback(async (chatId: string): Promise<AiaAttachResult> => {
    const generation = beginConversationAttempt();
    try {
      const connection = await attachChat(chatId, (event) => {
        if (generation === generationRef.current) handleEvent(event);
      });
      return (await claimConnection(generation, connection)) ? "attached" : "stale";
    } catch {
      setSession(null);
      return "failed";
    } finally {
      endConversationAttempt();
    }
  }, [beginConversationAttempt, claimConnection, endConversationAttempt, handleEvent]);

  const runRestoreOrStartConversation = useCallback(async () => {
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
        const selected = selectAiaWindowSession(aiaChatsForProvider(liveChats, provider, runtime), window.localStorage, window.sessionStorage, windowId);
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
  }, [attachConversation, provider, runtime, startConversation, windowId]);

  /**
   * 연결 작업을 순서대로 처리한다. 진행 중이라고 다음 요청을 버리면 그 사이에 무효해진
   * attach 결과를 아무도 대신 받지 못해(세대 검사에서 이벤트가 전부 버려져) 세션 정보만
   * 있고 대화는 빈 화면으로 남는다. 팝업을 처음 열 때(StrictMode의 이중 마운트·개발 HMR
   * 재마운트)가 그 경우였다.
   */
  const queueConversationWork = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const pending = conversationQueueRef.current.then(task, task);
    conversationQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }, []);

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
   * 어긋나면, 그 대화를 정지·분리한 뒤 새 설정으로 다시 시작한다.
   */
  const staleRuntime = aiaRuntimeNeedsRestart(session, provider, runtime);
  // 턴이 도는 중이거나 승인을 기다리는 중에 끊으면 하던 작업과 승인 요청이 사라진다.
  // 턴이 끝나면 세션 상태 이벤트가 다시 와서 이 이펙트가 그때 다시 시작한다.
  const restartBlockedByTurn = staleRuntime && (phase === "running" || phase === "waitingApproval");
  useEffect(() => {
    if (!providerConnected || restartingRef.current || startingRef.current) return;
    if (!staleRuntime || restartBlockedByTurn) return;
    restartingRef.current = true;
    void (async () => {
      try {
        const connection = takeConnection();
        activeTurnRef.current = null;
        if (connection) await shutdownConnection(connection);
        setSession(null);
        setTurns([]);
        setQueue([]);
        setError(null);
        if (open) {
          autoStartedRef.current = true;
          await restoreOrStartConversation();
        } else {
          // 닫혀 있으면 지금 시작하지 않는다. 다음에 열릴 때 자동 시작 이펙트가 새 공급자로 시작하도록 되돌린다.
          autoStartedRef.current = false;
          setPhase("connecting");
        }
      } finally {
        restartingRef.current = false;
      }
    })();
  }, [open, provider, providerConnected, restartBlockedByTurn, restoreOrStartConversation, session, staleRuntime, takeConnection]);

  const runSwitchConversation = useCallback(async (chatId: string): Promise<boolean> => {
    const connected = connectionRef.current;
    if (connected?.info.chatId === chatId) return true;

    const previousChatId = connected?.info.chatId ?? null;
    const generation = beginConversationAttempt();
    connectionRef.current = null;
    activeTurnRef.current = null;
    setAttachments([]);

    let detachedPrevious = false;
    try {
      if (connected) {
        await connected.detach();
        detachedPrevious = true;
      }
      const next = await attachChat(chatId, (event) => {
        if (generation === generationRef.current) handleEvent(event);
      });
      return await claimConnection(generation, next);
    } catch (cause) {
      let restored = false;
      if (detachedPrevious && previousChatId) {
        const restoreGeneration = generationRef.current + 1;
        generationRef.current = restoreGeneration;
        try {
          const previous = await attachChat(previousChatId, (event) => {
            if (restoreGeneration === generationRef.current) handleEvent(event);
          });
          connectionRef.current = previous;
          applySession(previous.info);
          restored = true;
        } catch {
          // The previous runtime remains discoverable and can be retried when AIA reopens.
        }
      }
      if (!restored) {
        setSession(null);
        setPhase("failed");
      }
      setError(`${restored ? "기존 AIA 대화는 유지했지만 " : ""}승인 요청 대화로 전환하지 못했습니다: ${errorText(cause)}`);
      return false;
    } finally {
      endConversationAttempt();
    }
  }, [applySession, beginConversationAttempt, claimConnection, endConversationAttempt, handleEvent]);

  const switchConversation = useCallback(
    (chatId: string) => queueConversationWork(() => runSwitchConversation(chatId)),
    [queueConversationWork, runSwitchConversation],
  );

  useEffect(() => {
    if (!attentionTarget) return undefined;
    const action = aiaAttentionTargetAction(open, providerConnected, starting);
    if (action === "wait") return undefined;
    if (action === "reject") {
      // 팝업 본문이 CLI 연결 필요를 이미 안내하므로 대상만 실패로 소비한다(읽음 처리 없음).
      onAttentionTargetHandled(attentionTarget, false);
      return undefined;
    }
    let cancelled = false;
    void switchConversation(attentionTarget.chatId).then((opened) => {
      // 밀려난 전환의 결과로 알림을 소비하면, 뒤이어 성공한 전환이 읽음 처리를 못 한다.
      if (!cancelled) onAttentionTargetHandled(attentionTarget, opened);
    });
    return () => { cancelled = true; };
  }, [attentionTarget, onAttentionTargetHandled, open, providerConnected, starting, switchConversation]);

  useEffect(() => {
    if (open) followLatestMessagesRef.current = true;
  }, [activeChatId, open]);

  const pauseFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = false;
  }, []);
  const resumeFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = true;
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!followLatestMessagesRef.current) return;
      const stream = streamRef.current;
      if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, turns]);

  // 링크 문서 미리보기가 이 팝업 위에 뜨면 Esc는 미리보기부터 닫는다(useEscapeToClose가 겹침 순서를 지킨다).
  useEscapeToClose(onClose, open);

  const closeLinkedFilePreview = linkedFilePreview.close;
  useEffect(() => {
    if (!open) closeLinkedFilePreview();
  }, [closeLinkedFilePreview, open]);

  useEffect(() => () => {
    const connection = takeConnection();
    if (connection) void connection.detach();
  }, [takeConnection]);

  // 승인 대기는 사용자를 기다리는 멈춤 상태라 "진행 중"에서 뺀다. 그쪽은 알림(attention)이 맡는다.
  useEffect(() => { onBusyChange(phase === "running"); }, [onBusyChange, phase]);
  useEffect(() => () => { onBusyChange(false); }, [onBusyChange]);

  const busy = phase === "running" || phase === "waitingApproval";
  const hasDraft = Boolean(composer.trim() || attachments.length > 0);
  // 메뉴가 열려 있는 동안에는 응답이 끝나도 이 자리를 지킨다. 팝오버가 손가락 밑에서
  // 사라지면 고른 항목이 실행되지 않고 조용히 없던 일이 된다.
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const composerUsable = Boolean(session) && (phase === "ready" || busy);
  const pendingApprovals = useMemo(() => turns
    .flatMap((turn) => turn.entries)
    .filter((entry): entry is Extract<AiaEntry, { type: "approval" }> => (
      entry.type === "approval" && entry.interactive && !entry.resolved
    )), [turns]);

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
    handledAutoPromptRef.current = autoPrompt.requestId;
    void connection.send(autoPrompt.text)
      .then(() => onAutoPromptHandled(autoPrompt, true))
      .catch((cause) => {
        setError(errorText(cause));
        onAutoPromptHandled(autoPrompt, false);
      });
  }, [autoPrompt, composerUsable, onAutoPromptHandled, open, phase, providerConnected, restoreOrStartConversation]);

  const focusComposerAtEnd = useCallback(() => {
    const textarea = composerRef.current;
    if (!textarea || textarea.disabled) return false;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    pendingComposerFocusRef.current = false;
    return true;
  }, []);

  const insertPrompt = useCallback((prompt: string) => {
    setComposer((current) => mergeComposerDraft(current, prompt));
    pendingComposerFocusRef.current = true;
    window.requestAnimationFrame(() => { focusComposerAtEnd(); });
  }, [focusComposerAtEnd]);

  useEffect(() => {
    if (!pendingComposerFocusRef.current || !composerUsable) return;
    const frame = window.requestAnimationFrame(() => { focusComposerAtEnd(); });
    return () => window.cancelAnimationFrame(frame);
  }, [composer, composerUsable, focusComposerAtEnd]);

  const addFiles = (files: File[]) => {
    setAttachments((current) => addAttachmentDrafts(current, files, setError));
  };

  const removeAttachment = (draft: ChatAttachmentDraft) => {
    setAttachments((current) => current.filter((item) => item.key !== draft.key));
    releaseAttachmentDraftUpload(draft, connectionRef.current?.info.chatId);
  };

  /** deliverNow면 응답 중에도 중단 없이 진행 중인 작업에 바로 전달한다. */
  const deliverComposer = async (deliverNow: boolean) => {
    const text = composer.trim();
    const connection = connectionRef.current;
    if ((!text && attachments.length === 0) || uploading) return;
    // 쓴 글이 있는데 보낼 길이 없으면 이유를 남긴다. 조용히 돌아가면 사용자에게는
    // 버튼이 먹지 않는 것과 구분되지 않는다.
    if (!connection || !composerUsable) {
      setError("AIA에 연결되어 있지 않아 메시지를 보내지 못했습니다. 팝업을 닫았다 다시 열어 주세요.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const uploaded = await uploadAttachmentDrafts(connection.info.chatId, attachments, setAttachments);
      await connection.send(text, {
        steer: deliverNow,
        attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []),
      });
      setComposer("");
      setAttachments([]);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUploading(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    await deliverComposer(false);
  };

  /**
   * 지금 연결에 요청 하나를 보내고 실패는 오류 표시로만 남긴다. 연결이 없으면 보낼 곳이
   * 없다는 뜻이라 조용히 넘어간다 — 세 동작 모두 연결이 살아 있을 때만 UI에 나온다.
   */
  const runOnConnection = async (action: (connection: ChatConnection) => Promise<void>) => {
    const connection = connectionRef.current;
    if (!connection) return;
    try {
      await action(connection);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const decide = async (approvalId: string, decision: ChatApprovalDecision, answers?: Record<string, string>) => {
    setError(null);
    await runOnConnection((connection) => connection.approve(approvalId, decision, answers));
  };

  const removeQueued = async (messageId: string) => {
    await runOnConnection((connection) => connection.removeQueued(messageId));
  };

  const newConversation = async () => {
    const connection = takeConnection();
    if (connection) await shutdownConnection(connection);
    setSession(null);
    setTurns([]);
    setQueue([]);
    setComposer("");
    setAttachments([]);
    autoStartedRef.current = true;
    // 연결이 없던 상태(시작 실패 후 재시도)라면 백엔드에 남아 있는 AIA 대화 복원을 먼저 시도한다.
    if (connection) await startConversation();
    else await restoreOrStartConversation();
  };

  const interrupt = async () => {
    await runOnConnection((connection) => connection.interrupt());
  };

  return (
    <aside className={`aia-chat-popup${open ? " open" : ""}${yieldForGuide ? " guide-yield" : ""}${windowId ? " standalone" : ""}`} role="dialog" aria-label="AIA 시스템 에이전트" aria-hidden={!open}>
      <header className="aia-chat-header">
        <div className="aia-avatar"><AiaMark size={24} /></div>
        <div><strong>AIA <span>아이아</span></strong><small><i className={`terminal-status terminal-status-${phase}`} />Agent Manager ({providerName})</small></div>
        <div className="aia-header-actions">
          <button type="button" title="새 AIA 팝업창 열기" aria-label="새 AIA 팝업창 열기" onClick={() => {
            void openPopoutWindow({ kind: "aia", windowId: crypto.randomUUID() }).catch((cause) => setError(errorText(cause)));
          }}><ExternalLink size={15} /></button>
          {providerConnected && <button type="button" onClick={() => void newConversation()} disabled={starting} title={session ? "새 AIA 대화" : "AIA 다시 시작"}><RefreshCw size={15} /></button>}
          <button type="button" onClick={onClose} title="AIA 닫기"><X size={17} /></button>
        </div>
      </header>

      <AiaSuggestionDock suggestions={suggestions} onDismiss={onDismissSuggestion} onInsertPrompt={insertPrompt} />
      {!providerConnected ? (
        <AiaConnectPanel
          providerName={providerName}
          composerRef={composerRef}
          composer={composer}
          onComposerChange={setComposer}
          onConnectProvider={onConnectProvider}
        />
      ) : (
        <>
          <AiaConversationStream
            streamRef={streamRef}
            providerName={providerName}
            systemTools={session ? session.systemTools : supportsAiaSystemTools(provider)}
            starting={starting}
            turns={turns}
            chatId={session?.chatId ?? null}
            error={error}
            onDecision={decide}
            onOpenLocalLink={linkedFilePreview.open}
            onInsertPrompt={insertPrompt}
            onScrollAwayFromLatest={pauseFollowingLatestMessages}
            onScrollToLatest={resumeFollowingLatestMessages}
          />
          {restartBlockedByTurn && <p className="aia-runtime-restart-notice" role="status">실행설정이 바뀌었습니다. 진행 중인 작업이 끝나면 AIA를 정지하고 새 설정으로 다시 시작합니다.</p>}
          <ChatApprovalDock className="aia-approval-dock" label="시스템 기능 승인 대기" title="시스템 기능 승인" hint="검토 후 허용하세요." prompts={pendingApprovals} onDecision={decide} />
          <ChatQueueList items={queue} onRemove={(id) => void removeQueued(id)} onRecall={(item) => { void removeQueued(item.id); setComposer(item.text); setAttachments((current) => [...current, ...queuedAttachmentsToDrafts(item.attachments, session?.chatId ?? null)]); }} />
          <form className="aia-composer" onSubmit={send}>
            <AiaComposerTextarea
              inputRef={composerRef}
              value={composer}
              onChange={setComposer}
              onKeyDown={submitComposerOnEnter}
              onPaste={(event) => {
                const files = clipboardFiles(event);
                if (files.length > 0) addFiles(files);
              }}
              rows={1}
              placeholder={phase === "waitingApproval" ? "승인 대기 중입니다" : busy ? "응답 중 · 전송하면 대기열에 추가됩니다" : "AIA에게 질문하세요"}
              disabled={!composerUsable}
            />
            <VoiceInputControl value={composer} disabled={!composerUsable || uploading} onChange={setComposer} />
            <AttachmentPicker drafts={attachments} disabled={!composerUsable || uploading} onAdd={addFiles} onRemove={removeAttachment} />
            {(busy || sendMenuOpen) && hasDraft ? <ChatSendActionMenu
              hasDraft={hasDraft}
              sendDisabled={uploading}
              canDeliver={supportsDeliveryDuringTurn(session?.source ?? provider)}
              trigger={{ className: "aia-send", title: uploading ? "첨부 중…" : "보낼 방법 고르기", content: <Send size={16} /> }}
              onOpenChange={setSendMenuOpen}
              onQueue={() => void deliverComposer(false)}
              onDeliver={() => void deliverComposer(true)}
              onInterrupt={() => void interrupt()}
            /> : busy ? <button className="aia-stop" type="button" onClick={() => void interrupt()} title="현재 응답 중단"><Square size={14} /></button> : <button className="aia-send" type="submit" disabled={!composerUsable || uploading || !hasDraft} title={uploading ? "첨부 중…" : "전송"}><Send size={16} /></button>}
          </form>
        </>
      )}
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </aside>
  );
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
  return <textarea
    ref={inputRef}
    aria-label="AIA 메시지 입력"
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
  if (suggestions.length === 0) return null;
  return <section className="aia-suggestion-dock" aria-label="AIA 제안">
    <header><strong>먼저 확인해 보세요</strong>{suggestions.length > 3 && <span>외 {suggestions.length - 3}개</span>}</header>
    {suggestions.slice(0, 3).map((suggestion) => <article className={`aia-suggestion-card ${suggestion.severity}`} key={suggestion.fingerprint}>
      <div><small>{suggestion.packDisplayName}</small><strong>{suggestion.title}</strong><p>{suggestion.detail}</p></div>
      <div className="aia-suggestion-actions">
        <button type="button" onClick={() => onDismiss(suggestion)} title="이 제안 숨기기">숨기기</button>
        <button className="primary" type="button" onClick={() => onInsertPrompt(suggestion.prompt)}>명령 입력</button>
      </div>
    </article>)}
  </section>;
}

/** 시스템 에이전트 공급자가 아직 연결되지 않았을 때의 안내. 초안은 여기서도 쓸 수 있게 둔다. */
function AiaConnectPanel({ providerName, composerRef, composer, onComposerChange, onConnectProvider }: {
  providerName: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  composer: string;
  onComposerChange: (value: string) => void;
  onConnectProvider: () => void;
}) {
  return <div className="aia-unavailable">
    <AiaMark size={34} />
    <strong>AIA를 시작하려면 {providerName} CLI 연결이 필요합니다.</strong>
    <small>시스템 설정 &gt; 시스템 에이전트에서 다른 공급자를 고를 수도 있습니다.</small>
    <button className="button primary" type="button" onClick={onConnectProvider}>{providerName} 연결</button>
    <AiaComposerTextarea
      inputRef={composerRef}
      value={composer}
      onChange={onComposerChange}
      rows={3}
      placeholder="제안 명령을 선택하면 여기에 초안으로 추가됩니다"
    />
    {composer && <small>초안은 연결 후에도 유지되며 자동 전송되지 않습니다.</small>}
  </div>;
}

/** 인사말·연결 표시·턴 목록·오류를 담은 대화 흐름과 그 스크롤 조작. */
function AiaConversationStream({ streamRef, providerName, systemTools, starting, turns, chatId, error, onDecision, onOpenLocalLink, onInsertPrompt, onScrollAwayFromLatest, onScrollToLatest }: {
  streamRef: RefObject<HTMLDivElement | null>;
  providerName: string;
  systemTools: boolean;
  starting: boolean;
  turns: AiaTurn[];
  chatId: string | null;
  error: string | null;
  onDecision: (id: string, decision: ChatApprovalDecision) => void;
  onOpenLocalLink: (href: string) => void;
  onInsertPrompt: (prompt: string) => void;
  onScrollAwayFromLatest: () => void;
  onScrollToLatest: () => void;
}) {
  return <div className="aia-chat-stream-shell">
    <div className="aia-chat-stream" aria-live="polite" ref={streamRef}>
      <article className="aia-welcome">
        <strong>안녕하세요, AIA입니다.</strong>
        <p>Agent Manager의 상태를 확인하거나 작업요청·설정변경·세션확인·반복 요청 작성 등 작업명령을 요청할 수 있습니다.</p>
        {!systemTools && <p className="aia-capability-warning" role="status">{providerName} CLI는 실행 단위 MCP 설정을 제공하지 않아 이 런타임에서는 시스템 도구를 쓸 수 없습니다. 설정·세션을 직접 조작하려면 시스템 설정에서 Codex 또는 Claude를 고르세요.</p>}
      </article>
      {starting && turns.length === 0 && <div className="aia-connecting"><span className="spin">◌</span> 시스템 인터페이스 연결 중…</div>}
      {turns.map((turn) => <AiaTurnView turn={turn} chatId={chatId} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} onInsertPrompt={onInsertPrompt} key={turn.id} />)}
      {error && <ErrorBanner message={error} />}
    </div>
    <ChatScrollControls
      targetRef={streamRef}
      onScrollAwayFromLatest={onScrollAwayFromLatest}
      onScrollToLatest={onScrollToLatest}
    />
  </div>;
}

function AiaTurnView({ turn, chatId, onDecision, onOpenLocalLink, onInsertPrompt }: { turn: AiaTurn; chatId: string | null; onDecision: (id: string, decision: ChatApprovalDecision) => void; onOpenLocalLink: (href: string) => void; onInsertPrompt?: (prompt: string) => void }) {
  const segments = segmentChatTimeline(turn.entries, isActivity, isVisible, entryKey);
  const running = isRunningTurn(turn.status);
  const lastAssistantMessage = [...turn.entries].reverse().find((entry) => entry.type === "message" && entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text));
  const lastActivity = segments.reduce((latest, segment, index) => segment.type === "activity" ? index : latest, -1);
  return <section className="aia-turn">{segments.map((segment, index) => {
    if (segment.type === "entry") {
      const isCompletedFinal = !running && segment.entry === lastAssistantMessage;
      return <AiaEntryView entry={segment.entry} chatId={chatId} copyReady={!running} speechReady={isReadableFinalResponse(turn.status, isCompletedFinal)} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} onInsertPrompt={isCompletedFinal ? onInsertPrompt : undefined} key={segment.key} />;
    }
    const entries = segment.entries as AiaActivityEntry[];
    // 스킬 실행은 작업 로그가 아니라 대화 흐름에 사용 스킬 카드로 세운다(ChatConversation과 같은 규칙).
    const skillUsages = collectChatSkillUsages(entries);
    const logged = entries.filter((entry) => !isSkillUsageEntry(entry));
    const active = running && index === segments.length - 1;
    const status = active ? "running" : index === lastActivity ? turn.status : "completed";
    return <Fragment key={segment.key}>
      <ChatSkillUsageCard usages={skillUsages} />
      {logged.length > 0 && <ChatActivityGroup entries={logged} active={active} status={status} statusText={active ? "작업 중" : "완료"} summary={activitySummary(logged)} entryKey={entryKey} renderEntry={(entry) => <AiaEntryView entry={entry} chatId={chatId} copyReady={!running} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />} />}
    </Fragment>;
  })}</section>;
}

function AiaEntryView({ entry, chatId, copyReady, speechReady = false, onDecision, onOpenLocalLink, onInsertPrompt }: { entry: AiaEntry; chatId: string | null; copyReady: boolean; speechReady?: boolean; onDecision: (id: string, decision: ChatApprovalDecision) => void; onOpenLocalLink: (href: string) => void; onInsertPrompt?: (prompt: string) => void }) {
  if (entry.type === "message") {
    const copyable = entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text);
    return <article className={`chat-message chat-message-${entry.role} chat-message-${entry.kind}`}>
      <strong>{entry.kind === "reasoning" ? "AIA 작업" : entry.role === "user" ? "사용자" : "AIA"}</strong>
      {copyable && speechReady && <SpeechPlaybackAction responseId={`aia:${chatId ?? "chat"}:${entry.id}`} text={entry.text} />}
      {copyable && <CopyAction value={entry.text} kind="response" className="message-copy-action" disabled={!copyReady} />}
      {entry.text && <div className="chat-message-markdown"><MarkdownPreview source={entry.text} compact copyable={copyable && copyReady} onOpenLocalLink={onOpenLocalLink} onInsertPrompt={entry.role === "assistant" ? onInsertPrompt : undefined} /></div>}
      <ChatAttachmentList chatId={chatId} files={entry.attachments} />
    </article>;
  }
  if (entry.type === "tool") return <ChatToolCard name={entry.name} status={entry.status} detail={entry.detail} output={entry.output} />;
  if (entry.type === "approval") return <ChatApprovalCard prompt={entry} onDecision={onDecision} />;
  return <article className="chat-event-error">{entry.text}</article>;
}

/**
 * 화면에서 뗀 실행을 정리한다. 이미 멈췄거나 떨어져 있어도 남은 단계를 막지 않도록 두
 * 단계 모두 실패를 삼킨다.
 */
async function shutdownConnection(connection: ChatConnection): Promise<void> {
  try { await connection.stop(); } catch { /* The provider may already be stopped. */ }
  try { await connection.detach(); } catch { /* The stopped runtime can remain detached. */ }
}

function upsertMessage(current: AiaEntry[], event: Extract<ChatEvent, { type: "messageDelta" }>): AiaEntry[] {
  const index = current.findIndex((entry) => entry.type === "message" && entry.id === event.id && entry.kind === event.kind);
  if (index < 0) return [...current, { type: "message", id: event.id, role: event.role, kind: event.kind, text: event.delta, attachments: [] }];
  return current.map((entry, entryIndex) => entryIndex === index && entry.type === "message" ? { ...entry, text: entry.text + event.delta } : entry);
}

function upsertTool(current: AiaEntry[], event: Extract<ChatEvent, { type: "tool" }>): AiaEntry[] {
  const index = current.findIndex((entry) => entry.type === "tool" && entry.id === event.id);
  if (index < 0) return [...current, { type: "tool", id: event.id, name: event.name, status: event.status, detail: event.detail ?? "", output: event.output ?? "" }];
  return current.map((entry, entryIndex) => entryIndex !== index || entry.type !== "tool" ? entry : {
    ...entry,
    name: event.name || entry.name,
    status: event.status,
    detail: event.append ? entry.detail + (event.detail ?? "") : (event.detail ?? entry.detail),
    output: event.append ? entry.output + (event.output ?? "") : (event.output ?? entry.output),
  });
}

function isActivity(entry: AiaEntry): entry is AiaActivityEntry {
  return entry.type === "tool" || (entry.type === "message" && entry.kind === "reasoning");
}

function isVisible(entry: AiaEntry): boolean {
  return entry.type !== "approval" || !entry.interactive || Boolean(entry.resolved);
}

function entryKey(entry: AiaEntry): string {
  return entry.type === "message" ? `${entry.type}-${entry.id}-${entry.kind}` : `${entry.type}-${entry.id}`;
}

function activitySummary(entries: AiaActivityEntry[]): string {
  const toolCount = entries.filter((entry) => entry.type === "tool").length;
  return toolCount > 0 ? `시스템 도구 ${toolCount}개` : "AIA 진행 상황";
}
