import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, ChevronDown, ExternalLink, MessagesSquare, PanelLeftClose, PanelLeftOpen, Plus, ScrollText, X } from "lucide-react";
import { attachChat, connectChat, removeChatInputFile, type ChatConnection } from "../lib/chat";
import {
  cancelAndRecoverScheduledRun,
  cancelScheduledRun,
  createScheduledRequest,
  deleteScheduledRequest,
  downloadChatLinkedFile,
  getBackgroundSettings,
  getChatLinkedFile,
  getLiveChats,
  getSchedulerSnapshot,
  hasTauriRuntime,
  openProviderSessionApp,
  runScheduledRequestNow,
  setScheduleEnabled,
  setBackgroundSettings,
  setSchedulesPaused,
  updateScheduledRequest,
} from "../lib/ipc";
import { formatDate, formatRelative } from "../lib/format";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatApprovalDecision,
  ChatEvent,
  ChatMode,
  ChatModelCatalogOption,
  ChatPhase,
  ChatProviderOptions,
  ChatReasoningOption,
  ChatSessionInfo,
  ModelOption,
  ProjectOption,
  ProviderId,
  ProviderStatus,
  QueuedChatMessage,
  ReasoningEffort,
  ResumeFailurePolicy,
  ScheduleFrequency,
  ScheduleRun,
  ScheduledRequest,
  ScheduledRequestInput,
  SchedulerSnapshot,
  SessionSummary,
} from "../types";
import { ChatApprovalCard, ErrorBanner, EmptyState, SourceBadge } from "./Shared";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { ChatRuntimeSettingsMenu } from "./ChatRuntimeSettingsMenu";
import {
  appendAttachmentDrafts,
  AttachmentPicker,
  clipboardFiles,
  queuedAttachmentsToDrafts,
  uploadAttachmentDrafts,
  type ChatAttachmentDraft,
} from "./ChatAttachments";
import { ChatComposer } from "./ChatComposer";
import {
  activityMatches,
  applyChatEvent,
  ChatConversationTurn,
  ChatEntryView,
  ChatScrollControls,
  chatTurnStatusLabel,
  type ChatEntry,
  type ChatTurn,
} from "./ChatConversation";
import {
  approvalModeLabel,
  defaultApprovalMode,
  effectiveApprovalMode,
  permissionModeLabel,
  reasoningLabel,
  sameChatSettings,
  settingField,
  settingFieldsFor,
} from "../lib/chatSettings";
import type { ChatSettingField } from "../types";
import { reasoningOptionsFor, refreshProviderOptions, useProviderOptions } from "../lib/providerOptions";

interface ChatViewProps {
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  projects: ProjectOption[];
  models: ModelOption[];
  sessions: SessionSummary[];
  autoShowNewMessages: boolean;
  onConnectCli: (provider: ProviderStatus) => void;
  onOpenSession: (session: SessionSummary) => void;
  onSessionCatalogChanged: (source: ProviderId, id: string) => Promise<void>;
  attentionTarget: ChatViewAttentionTarget | null;
  onAttentionTargetHandled: (target: ChatViewAttentionTarget, opened: boolean) => void;
  scheduleFocusRequest?: number;
}

export interface ChatViewAttentionTarget {
  chatId: string;
  attentionId: string;
  markRead: boolean;
  requestId: number;
}

type ChatTab = "conversation" | "activity" | "schedules";
type ActivityFilter = "all" | "tool" | "reasoning" | "error";

const MANUAL_CWD = "__manual_cwd__";

export function ChatView({ providers, accounts, projects, models, sessions, autoShowNewMessages, onConnectCli, onOpenSession, onSessionCatalogChanged, attentionTarget, onAttentionTargetHandled, scheduleFocusRequest }: ChatViewProps) {
  const available = useMemo(() => providers.filter((provider) => provider.cli.detected), [providers]);
  const unavailable = useMemo(() => providers.filter((provider) => !provider.cli.detected), [providers]);
  const initialSource = available[0]?.provider ?? "codex";
  const [tab, setTab] = useState<ChatTab>("conversation");
  const [chatListOpen, setChatListOpen] = useState(() => !window.matchMedia("(max-width: 760px)").matches);
  // 대시보드 '반복 일정' 패널에서 넘어온 요청은 반복 요청 탭을 바로 연다.
  useEffect(() => {
    if (scheduleFocusRequest) setTab("schedules");
  }, [scheduleFocusRequest]);
  const [source, setSource] = useState<ProviderId>(initialSource);
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
  const [phase, setPhase] = useState<ChatPhase | "connecting">("connecting");
  const [queue, setQueue] = useState<QueuedChatMessage[]>([]);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [chatSwitching, setChatSwitching] = useState(false);
  const [openingProviderApp, setOpeningProviderApp] = useState(false);
  const connectionRef = useRef<ChatConnection | null>(null);
  const connectionGenerationRef = useRef(0);
  const sessionRef = useRef<ChatSessionInfo | null>(null);
  const phaseRef = useRef<ChatPhase | "connecting">("connecting");
  const turnsRef = useRef<ChatTurn[]>([]);
  const queueRef = useRef<QueuedChatMessage[]>([]);
  const composerRef = useRef("");
  const composerAttachmentsRef = useRef<ChatAttachmentDraft[]>([]);
  const chatDraftsRef = useRef(new Map<string, { text: string; attachments: ChatAttachmentDraft[] }>());
  const chatScrollPositionsRef = useRef(new Map<string, number>());
  const chatSwitchingRef = useRef(false);
  const settingsChangeRef = useRef(false);
  const activeTurnRef = useRef<string | null>(null);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const followLatestMessagesRef = useRef(autoShowNewMessages);
  const providerOptions = useProviderOptions(source);
  const activeChatId = session?.chatId ?? null;
  const openChats = useMemo(() => {
    if (!session || liveChats.some((chat) => chat.chatId === session.chatId)) return liveChats;
    return [...liveChats, session];
  }, [liveChats, session]);
  const loadLinkedFile = useCallback((href: string) => {
    if (!activeChatId) return Promise.reject(new Error("연결된 채팅을 찾을 수 없습니다."));
    return getChatLinkedFile(activeChatId, href);
  }, [activeChatId]);
  const downloadLinkedFile = useCallback((href: string) => {
    if (!activeChatId) return Promise.reject(new Error("연결된 채팅을 찾을 수 없습니다."));
    return downloadChatLinkedFile(activeChatId, href);
  }, [activeChatId]);
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);

  const switchSource = useCallback((nextSource: ProviderId) => {
    setSource(nextSource);
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

  const refreshLiveChats = useCallback(async () => {
    try {
      setLiveChats(await getLiveChats("standard"));
    } catch {
      // A transient snapshot failure must not disconnect the chat currently on screen.
    }
  }, []);

  useEffect(() => {
    if (!session && available.length > 0 && !available.some((provider) => provider.provider === source)) {
      switchSource(available[0].provider);
    }
  }, [available, session, source, switchSource]);

  useEffect(() => {
    void refreshLiveChats();
    const timer = window.setInterval(() => { void refreshLiveChats(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [refreshLiveChats]);

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
        applySessionInfo(info);
        if (info.providerSessionId) void onSessionCatalogChanged(info.source, info.providerSessionId);
      },
      onError: setError,
    });
  }, [applySessionInfo, onSessionCatalogChanged]);

  useEffect(() => {
    followLatestMessagesRef.current = autoShowNewMessages;
  }, [activeChatId, autoShowNewMessages]);

  const pauseFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = false;
  }, []);
  const resumeFollowingLatestMessages = useCallback(() => {
    followLatestMessagesRef.current = autoShowNewMessages;
  }, [autoShowNewMessages]);

  useEffect(() => {
    if (!autoShowNewMessages || !followLatestMessagesRef.current || tab !== "conversation") return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!followLatestMessagesRef.current) return;
      const stream = chatStreamRef.current;
      if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [turns, tab, autoShowNewMessages]);

  useEffect(() => () => {
    connectionGenerationRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) void connection.detach();
  }, []);

  const switchChat = useCallback(async (chatId: string): Promise<boolean> => {
    const connected = connectionRef.current;
    if (connected?.info.chatId === chatId) {
      setTab("conversation");
      return true;
    }
    if (chatSwitchingRef.current) return false;

    chatSwitchingRef.current = true;
    setChatSwitching(true);
    const previous = connected;
    const previousInfo = sessionRef.current ?? previous?.info ?? null;
    const previousPhase = phaseRef.current;
    const previousTurns = turnsRef.current;
    const previousQueue = queueRef.current;
    const previousComposer = composerRef.current;
    const previousAttachments = composerAttachmentsRef.current;
    const previousActiveTurn = activeTurnRef.current;
    if (previousInfo) {
      chatDraftsRef.current.set(previousInfo.chatId, { text: previousComposer, attachments: previousAttachments });
      chatScrollPositionsRef.current.set(previousInfo.chatId, chatStreamRef.current?.scrollTop ?? 0);
    }

    connectionGenerationRef.current += 1;
    const generation = connectionGenerationRef.current;
    connectionRef.current = null;
    activeTurnRef.current = null;
    setTab("conversation");
    setError(null);
    turnsRef.current = [];
    queueRef.current = [];
    setTurns([]);
    setQueue([]);
    const targetDraft = chatDraftsRef.current.get(chatId) ?? { text: "", attachments: [] };
    composerRef.current = targetDraft.text;
    composerAttachmentsRef.current = targetDraft.attachments;
    setComposer(targetDraft.text);
    setComposerAttachments(targetDraft.attachments);
    phaseRef.current = "connecting";
    setPhase("connecting");

    let detachedPrevious = false;
    try {
      if (previous) {
        await previous.detach();
        detachedPrevious = true;
      }
      const nextConnection = await attachChat(chatId, (event) => {
        if (generation === connectionGenerationRef.current) handleEvent(event);
      });
      connectionRef.current = nextConnection;
      applySessionInfo(nextConnection.info);
      const scrollTop = chatScrollPositionsRef.current.get(nextConnection.info.chatId);
      if (scrollTop !== undefined) {
        window.requestAnimationFrame(() => chatStreamRef.current?.scrollTo({ top: scrollTop, behavior: "auto" }));
      }
      return true;
    } catch (cause) {
      let restored = false;
      if (previousInfo && previous && detachedPrevious) {
        try {
          const previousGeneration = connectionGenerationRef.current + 1;
          connectionGenerationRef.current = previousGeneration;
          const previousConnection = await attachChat(previousInfo.chatId, (event) => {
            if (previousGeneration === connectionGenerationRef.current) handleEvent(event);
          });
          connectionRef.current = previousConnection;
          applySessionInfo(previousConnection.info);
          turnsRef.current = previousTurns;
          queueRef.current = previousQueue;
          setTurns(previousTurns);
          setQueue(previousQueue);
          composerRef.current = previousComposer;
          composerAttachmentsRef.current = previousAttachments;
          setComposer(previousComposer);
          setComposerAttachments(previousAttachments);
          phaseRef.current = previousPhase;
          setPhase(previousPhase);
          activeTurnRef.current = previousActiveTurn;
          restored = true;
        } catch {
          // The previous runtime remains discoverable in the live-chat tabs.
        }
      } else if (previousInfo && previous) {
        connectionRef.current = previous;
        applySessionInfo(previousInfo);
        turnsRef.current = previousTurns;
        queueRef.current = previousQueue;
        setTurns(previousTurns);
        setQueue(previousQueue);
        composerRef.current = previousComposer;
        composerAttachmentsRef.current = previousAttachments;
        setComposer(previousComposer);
        setComposerAttachments(previousAttachments);
        phaseRef.current = previousPhase;
        setPhase(previousPhase);
        activeTurnRef.current = previousActiveTurn;
        restored = true;
      }
      if (!restored) {
        sessionRef.current = null;
        setSession(null);
      }
      setError(`${restored ? "이전 채팅은 유지했지만 " : ""}채팅으로 전환하지 못했습니다: ${errorMessage(cause)}`);
      return false;
    } finally {
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      void refreshLiveChats();
    }
  }, [applySessionInfo, handleEvent, refreshLiveChats]);

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
      if (result.error) setError(result.error);
      return result.drafts;
    });
  };

  const addComposerFiles = (files: File[]) => {
    setComposerAttachments((current) => {
      const result = appendAttachmentDrafts(current, files);
      if (result.error) setError(result.error);
      composerAttachmentsRef.current = result.drafts;
      return result.drafts;
    });
  };

  const removeComposerAttachment = (draft: ChatAttachmentDraft) => {
    const next = composerAttachmentsRef.current.filter((item) => item.key !== draft.key);
    composerAttachmentsRef.current = next;
    setComposerAttachments(next);
    if (draft.uploaded && draft.ownedUpload && sessionRef.current) {
      void removeChatInputFile(sessionRef.current.chatId, draft.uploaded.id).catch(() => undefined);
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
      const generation = connectionGenerationRef.current + 1;
      connectionGenerationRef.current = generation;
      const connection = await connectChat(
        { source, cwd: cwd.trim(), model: model.trim() || null, reasoningEffort: reasoningEffort || null, mode, approvalMode, resumeSessionId: null, unattended: false, settings: extraSettings },
        (chatEvent) => {
          if (generation === connectionGenerationRef.current) handleEvent(chatEvent);
        },
      );
      connectionRef.current = connection;
      applySessionInfo(connection.info);
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
        setError(`채팅은 시작했지만 첫 메시지를 보내지 못했습니다: ${errorMessage(cause)}`);
      } else {
        sessionRef.current = null;
        setSession(null);
        setError(errorMessage(cause));
      }
    } finally {
      setUploadingAttachments(false);
      setStarting(false);
      void refreshLiveChats();
    }
  };

  const chatBusy = phase === "running" || phase === "waitingApproval";
  const composerUsable = phase === "ready" || chatBusy;
  const pendingApprovals = turns.flatMap((turn) => turn.entries).filter((entry): entry is Extract<ChatEntry, { type: "approval" }> => entry.type === "approval" && entry.interactive && !entry.resolved);

  const deliverComposer = async (steer: boolean) => {
    const text = composer.trim();
    const connection = connectionRef.current;
    const drafts = composerAttachmentsRef.current;
    if ((!text && drafts.length === 0) || !connection || !composerUsable || uploadingAttachments) return;
    setError(null);
    setUploadingAttachments(true);
    try {
      const uploaded = await uploadAttachmentDrafts(connection.info.chatId, drafts, (next) => {
        composerAttachmentsRef.current = next;
        setComposerAttachments(next);
      });
      await connection.send(text, {
        steer,
        attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []),
      });
      composerRef.current = "";
      composerAttachmentsRef.current = [];
      setComposer("");
      setComposerAttachments([]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUploadingAttachments(false);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    await deliverComposer(false);
  };

  const removeQueued = async (messageId: string) => {
    setError(null);
    try { await connectionRef.current?.removeQueued(messageId); }
    catch (cause) { setError(errorMessage(cause)); }
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
      const attachments = [...composerAttachmentsRef.current, ...queuedAttachmentsToDrafts(message.attachments)];
      composerAttachmentsRef.current = attachments;
      setComposerAttachments(attachments);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const decide = async (approvalId: string, decision: ChatApprovalDecision) => {
    setError(null);
    try { await connectionRef.current?.approve(approvalId, decision); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  const interrupt = async () => {
    setError(null);
    try { await connectionRef.current?.interrupt(); }
    catch (cause) { setError(errorMessage(cause)); }
  };

  interface ActiveChatSettings {
    mode: ChatMode;
    approvalMode: ChatApprovalMode;
    model: string;
    reasoningEffort: ReasoningEffort | "";
    extraSettings: Record<string, string>;
  }

  const changeActiveChatSettings = async (next: Partial<ActiveChatSettings>, label: string) => {
    if (!session || phase === "connecting" || chatBusy || settingsChangeRef.current) return;
    const target: ActiveChatSettings = { mode, approvalMode, model, reasoningEffort, extraSettings, ...next };
    if (target.mode === mode
      && target.approvalMode === approvalMode
      && target.model === model
      && target.reasoningEffort === reasoningEffort
      && sameChatSettings(target.extraSettings, extraSettings)) return;
    if (!session.providerSessionId && turns.length > 0) {
      setError(`${label} 변경하려면 공급자 세션 연결이 완료되어야 합니다.`);
      return;
    }

    const previous: ActiveChatSettings = { mode, approvalMode, model, reasoningEffort, extraSettings };
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
        setError(`${label} 변경하지 못했습니다: ${errorMessage(cause)}`);
        settingsChangeRef.current = false;
        return;
      }
    }

    const generation = connectionGenerationRef.current + 1;
    connectionGenerationRef.current = generation;
    connectionRef.current = null;
    if (connection) {
      try { await connection.detach(); } catch { /* The stopped provider process is safe to leave detached. */ }
    }
    setQueue([]);
    setPhase("connecting");
    try {
      const nextConnection = await connectChat({
        source: session.source,
        cwd: session.cwd,
        model: target.model.trim() || null,
        reasoningEffort: target.reasoningEffort || null,
        mode: target.mode,
        approvalMode: target.approvalMode,
        resumeSessionId: session.providerSessionId,
        unattended: false,
        settings: target.extraSettings,
      }, (chatEvent) => {
        if (generation === connectionGenerationRef.current) handleEvent(chatEvent);
      });
      connectionRef.current = nextConnection;
      applySessionInfo(nextConnection.info);
      saveChatLaunchSettings(session.source, {
        model: target.model.trim(),
        reasoningEffort: target.reasoningEffort,
      });
    } catch (cause) {
      setPhase("stopped");
      setError(`${label} 변경 후 채팅에 다시 연결하지 못했습니다: ${errorMessage(cause)}`);
    }
    settingsChangeRef.current = false;
  };

  const newChat = async () => {
    if (chatSwitchingRef.current) return;
    chatSwitchingRef.current = true;
    setChatSwitching(true);
    try {
      const connection = connectionRef.current;
      if (connection) {
        const current = sessionRef.current ?? connection.info;
        chatDraftsRef.current.set(current.chatId, {
          text: composerRef.current,
          attachments: composerAttachmentsRef.current,
        });
        chatScrollPositionsRef.current.set(current.chatId, chatStreamRef.current?.scrollTop ?? 0);
        await connection.detach();
      }
      connectionGenerationRef.current += 1;
      connectionRef.current = null;
      sessionRef.current = null;
      activeTurnRef.current = null;
      setSession(null);
      turnsRef.current = [];
      queueRef.current = [];
      setTurns([]);
      setQueue([]);
      composerRef.current = "";
      composerAttachmentsRef.current = [];
      setComposer("");
      setComposerAttachments([]);
      setError(null);
      phaseRef.current = "connecting";
      setPhase("connecting");
      void refreshProviderOptions(source).catch((cause) => {
        setError(`최신 실행 설정을 불러오지 못했습니다: ${errorMessage(cause)}`);
      });
    } catch (cause) {
      setError(`현재 채팅을 백그라운드로 보내지 못했습니다: ${errorMessage(cause)}`);
    } finally {
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      void refreshLiveChats();
    }
  };

  const stopCurrentChat = async () => {
    const connection = connectionRef.current;
    const current = sessionRef.current;
    if (!connection || !current || chatSwitchingRef.current) return;
    const active = phaseRef.current === "running" || phaseRef.current === "waitingApproval";
    const message = active
      ? "현재 진행 중인 작업과 대기열을 종료할까요? 종료한 실행은 채팅 목록에서 제거됩니다."
      : "현재 채팅 실행을 종료할까요? 종료한 실행은 채팅 목록에서 제거됩니다.";
    if (!window.confirm(message)) return;

    const nextChatId = openChats.find((chat) => chat.chatId !== current.chatId)?.chatId ?? null;
    chatSwitchingRef.current = true;
    setChatSwitching(true);
    setError(null);
    try {
      await connection.stop();
    } catch (cause) {
      setError(`채팅 실행을 종료하지 못했습니다: ${errorMessage(cause)}`);
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      return;
    }
    connectionGenerationRef.current += 1;
    connectionRef.current = null;
    try { await connection.detach(); } catch { /* The process is already stopped. */ }
    setLiveChats((chats) => chats.filter((chat) => chat.chatId !== current.chatId));
    chatDraftsRef.current.delete(current.chatId);
    chatScrollPositionsRef.current.delete(current.chatId);
    sessionRef.current = null;
    activeTurnRef.current = null;
    setSession(null);
    turnsRef.current = [];
    queueRef.current = [];
    setTurns([]);
    setQueue([]);
    composerRef.current = "";
    composerAttachmentsRef.current = [];
    setComposer("");
    setComposerAttachments([]);
    phaseRef.current = "connecting";
    setPhase("connecting");
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
    if (chatSwitchingRef.current) return;
    const active = chat.state === "running" || chat.state === "waitingApproval";
    const message = active
      ? "이 채팅에서 진행 중인 작업과 대기열을 종료할까요?"
      : "이 채팅 실행을 종료하고 목록에서 제거할까요?";
    if (!window.confirm(message)) return;

    chatSwitchingRef.current = true;
    setChatSwitching(true);
    setError(null);
    let backgroundConnection: ChatConnection | null = null;
    try {
      backgroundConnection = await attachChat(chat.chatId, () => {});
      await backgroundConnection.stop();
      try { await backgroundConnection.detach(); } catch { /* The stopped process is safe to leave detached. */ }
      setLiveChats((chats) => chats.filter((candidate) => candidate.chatId !== chat.chatId));
      chatDraftsRef.current.delete(chat.chatId);
      chatScrollPositionsRef.current.delete(chat.chatId);
    } catch (cause) {
      if (backgroundConnection) {
        try { await backgroundConnection.detach(); } catch { /* Keep the active chat untouched on cleanup failure. */ }
      }
      setError(`채팅을 종료하지 못했습니다: ${errorMessage(cause)}`);
    } finally {
      chatSwitchingRef.current = false;
      setChatSwitching(false);
      void refreshLiveChats();
    }
  };

  const openInCodex = async () => {
    const providerSessionId = session?.providerSessionId;
    if (session?.source !== "codex" || !providerSessionId || openingProviderApp) return;
    setOpeningProviderApp(true);
    setError(null);
    connectionGenerationRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    try {
      if (connection) {
        try { await connection.stop(); } catch { /* The provider process may already be gone. */ }
        try { await connection.detach(); } catch { /* The handoff can still continue. */ }
      }
      setPhase("stopped");
      setQueue([]);
      await openProviderSessionApp(session.source, providerSessionId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setOpeningProviderApp(false);
    }
  };

  const tabs = (
    <div className="chat-hub-tabs" role="tablist" aria-label="채팅 보기">
      <button className={tab === "conversation" ? "active" : ""} type="button" onClick={() => setTab("conversation")}><MessagesSquare size={13} aria-hidden="true" /><span>대화</span></button>
      <button className={tab === "activity" ? "active" : ""} type="button" onClick={() => setTab("activity")}><ScrollText size={13} aria-hidden="true" /><span>작업 로그</span></button>
      <button className={tab === "schedules" ? "active" : ""} type="button" onClick={() => setTab("schedules")}><CalendarClock size={13} aria-hidden="true" /><span>반복 요청</span></button>
      {tab !== "schedules" && <button className="chat-list-toggle" type="button" aria-label={chatListOpen ? "채팅 목록 숨기기" : "채팅 목록 보기"} aria-controls="chat-runtime-list" aria-expanded={chatListOpen} onClick={() => setChatListOpen((open) => !open)}>
        {chatListOpen ? <PanelLeftClose size={15} aria-hidden="true" /> : <PanelLeftOpen size={15} aria-hidden="true" />}
        <span>{chatListOpen ? "채팅 목록 숨기기" : "채팅 목록 보기"}</span>
      </button>}
    </div>
  );

  const closeChatListOnMobile = () => {
    if (window.matchMedia("(max-width: 760px)").matches) setChatListOpen(false);
  };

  const runtimeList = chatListOpen ? (
    <aside className="chat-runtime-list" id="chat-runtime-list" aria-label="열린 채팅 목록">
      <header>
        <div><strong>채팅</strong><span>{openChats.length}</span></div>
        <button type="button" aria-label="채팅 목록 숨기기" title="채팅 목록 숨기기" onClick={() => setChatListOpen(false)}><PanelLeftClose size={15} /></button>
      </header>
      <div className="chat-runtime-list-items">
        <button className={`chat-runtime-list-new${session ? "" : " active"}`} type="button" aria-current={!session ? "page" : undefined} disabled={chatSwitching} onClick={() => { void newChat().then(closeChatListOnMobile); }}>
          <span><Plus size={15} aria-hidden="true" /></span><strong>새 채팅</strong>
        </button>
        {openChats.map((chat) => {
          const active = session?.chatId === chat.chatId;
          const title = chatTabTitle(chat, chatCatalogSession(chat, sessions));
          return <div className={`chat-runtime-list-item-shell${active ? " active" : ""}`} key={chat.chatId}>
            <button className="chat-runtime-list-item" type="button" aria-current={active ? "page" : undefined} disabled={chatSwitching} title={`${title} · ${providerLabel(chat.source)} · ${phaseLabel(chat.state)}`} onClick={() => { void switchChat(chat.chatId).then((opened) => { if (opened) closeChatListOnMobile(); }); }}>
              <span className={`terminal-status terminal-status-${chat.state}`} />
              <span><strong>{title}</strong><small>{providerLabel(chat.source)} · {phaseLabel(chat.state)}</small></span>
            </button>
            <button className="chat-runtime-list-close" type="button" disabled={chatSwitching} aria-label={`${title} 실행 종료 및 목록에서 제거`} title="실행 종료 및 목록에서 제거" onClick={() => { void stopBackgroundChat(chat); }}><X size={12} /></button>
          </div>;
        })}
      </div>
    </aside>
  ) : null;

  const runtimeBackdrop = chatListOpen
    ? <button className="chat-runtime-list-backdrop" type="button" aria-label="채팅 목록 닫기" onClick={() => setChatListOpen(false)} />
    : null;

  if (tab === "schedules") {
    return <div className="chat-hub">{tabs}<SchedulesPanel providers={available} accounts={accounts} projects={projects} models={models} sessions={sessions} currentSession={session} currentPrompt={composer} onOpenSession={onOpenSession} /></div>;
  }

  if (!session) {
    return (
      <div className="chat-hub">
        {tabs}
        <section className={`chat-runtime-layout${tab === "conversation" ? " chat-runtime-launch-shell" : ""}${chatListOpen ? " list-open" : " list-hidden"}`}>
          {runtimeList}
          {runtimeBackdrop}
          {tab === "activity" ? <div className="chat-runtime-empty"><EmptyState title="표시할 작업 로그가 없습니다" detail="대화를 시작하면 요청별 추론과 도구 실행이 여기에 모입니다." /></div> : (
            <section className="chat-launch-layout chat-launch-workspace">
              <article className="chat-launch-card">
              <div className="section-heading"><div><h2>새 CLI 채팅</h2><p>설치된 공급자 CLI를 구조화 채팅으로 시작합니다.</p></div></div>
              {unavailable.length > 0 && <div className="chat-cli-connections" aria-label="CLI 연결 필요">
                {unavailable.map((provider) => <button type="button" onClick={() => onConnectCli(provider)} key={provider.provider}>
                  <SourceBadge source={provider.provider} />
                  <span><strong>{provider.displayName}</strong><small>{provider.history.detected ? "채팅은 탐지됨 · CLI 연결 필요" : "CLI 연결 필요"}</small></span>
                  <em>연결</em>
                </button>)}
              </div>}
              {available.length === 0 ? <EmptyState title="연결 가능한 CLI가 없습니다" detail="위 공급자를 선택하면 설치·로그인용 터미널 가이드가 열립니다." /> : (
                <form className="chat-launch-form" onSubmit={start}>
                  <label><span>공급자</span><select value={source} onChange={(event) => switchSource(event.target.value as ProviderId)}>{available.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.displayName}</option>)}</select></label>
                  <label>
                    <span>작업 경로</span>
                    {projects.length > 0 && <select value={usingManualCwd ? MANUAL_CWD : cwd} onChange={(event) => { const value = event.target.value; setManualCwd(value === MANUAL_CWD); if (value !== MANUAL_CWD) setCwd(value); }}>{projects.map((project) => <option value={project.path} key={project.path}>{project.name} · {project.path}</option>)}<option value={MANUAL_CWD}>직접 입력…</option></select>}
                    {usingManualCwd ? <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/project/path" required autoFocus={manualCwd} /> : <small className="chat-path-hint">{selectedProject?.path} · 세션 {selectedProject?.count}개</small>}
                  </label>
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
                    extraSettings={extraSettings}
                    onExtraSettingChange={(key, value) => setExtraSettings((current) => ({ ...current, [key]: value }))}
                  />
                  <div className="chat-initial-composer"><label><span>첫 메시지 <small>선택</small></span><textarea value={initialPrompt} onChange={(event) => setInitialPrompt(event.target.value)} onPaste={(event) => { const files = clipboardFiles(event); if (files.length > 0) addInitialFiles(files); }} rows={1} placeholder="CLI 연결 직후 보낼 요청" /></label></div>
                  {error && <ErrorBanner message={error} />}
                  <div className="chat-launch-footer"><AttachmentPicker drafts={initialAttachments} disabled={starting} onAdd={addInitialFiles} onRemove={(draft) => setInitialAttachments((current) => current.filter((item) => item.key !== draft.key))} /><button className="button primary chat-start-button" type="submit" disabled={starting || !cwd.trim()}>{starting ? "CLI 연결 중…" : "새 채팅 시작"}</button></div>
                </form>
              )}
              </article>
            </section>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="chat-hub">
      {tabs}
      <section className={`chat-runtime-layout${chatListOpen ? " list-open" : " list-hidden"}`}>
        {runtimeList}
        {runtimeBackdrop}
        <section className="structured-chat">
        <header className="chat-session-header">
          <div><span className={`terminal-status terminal-status-${phase}`} /><div><strong>{providerLabel(session.source)} · {phaseLabel(phase)}</strong><small>{session.cwd}</small></div></div>
          <div className="chat-session-actions">
            {hasTauriRuntime() && session.source === "codex" && session.providerSessionId && <button className="button" type="button" disabled={openingProviderApp || phase === "running" || phase === "waitingApproval"} onClick={() => void openInCodex()} title="이 연결을 종료하고 같은 대화를 Codex 앱에서 엽니다"><ExternalLink size={13} />{openingProviderApp ? "여는 중…" : "Codex에서 열기"}</button>}
          </div>
        </header>
        <div className="chat-session-meta"><code>{session.providerSessionId ?? session.chatId}</code><span>{session.model ?? "기본 모델"}</span><span>추론 {session.reasoningEffort ? reasoningLabel(session.reasoningEffort) : "기본"}</span><span>{permissionModeLabel(session.mode)}</span><span>{approvalModeLabel(session.approvalMode)}</span></div>
        {error && <div className="chat-inline-error"><ErrorBanner message={error} /></div>}
        {tab === "activity" ? (
          <ActivityLog turns={turns} chatId={activeChatId} filter={activityFilter} onFilter={setActivityFilter} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} />
        ) : (
          <div className="chat-stream-shell">
            <div className="chat-stream" aria-live="polite" ref={chatStreamRef}>
              {turns.length === 0 && <EmptyState title="CLI가 연결되었습니다" detail="아래 입력창에서 첫 메시지를 보내세요." />}
              {turns.map((turn) => <ChatConversationTurn turn={turn} chatId={activeChatId} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} key={turn.id} />)}
            </div>
            <ChatScrollControls
              targetRef={chatStreamRef}
              onScrollAwayFromLatest={pauseFollowingLatestMessages}
              onScrollToLatest={resumeFollowingLatestMessages}
            />
          </div>
        )}
        {pendingApprovals.length > 0 && <div className="chat-approval-dock" aria-label="응답을 기다리는 권한 요청"><header><strong>권한 승인 대기</strong><span>선택할 때까지 에이전트 작업이 일시 정지됩니다.</span></header>{pendingApprovals.map((prompt) => <ChatApprovalCard prompt={prompt} onDecision={decide} key={prompt.id} />)}</div>}
        <ChatRuntimeSettingsMenu
          panelId="chat-runtime-settings-panel"
          contextLabel="채팅"
          source={session.source}
          mode={mode}
          approvalMode={approvalMode}
          model={model}
          modelOptions={providerOptions?.models ?? []}
          reasoningEffort={reasoningEffort}
          reasoningOptions={reasoningOptions}
          settingFields={settingFieldsFor(providerOptions, session.source)}
          extraSettings={extraSettings}
          locked={phase === "connecting" || chatBusy}
          statusIndicator={<span className={`terminal-status terminal-status-${phase}`} />}
          onOpen={() => {
            void refreshProviderOptions(session.source).catch((cause) => {
              setError(`최신 실행 설정을 불러오지 못했습니다: ${errorMessage(cause)}`);
            });
          }}
          onModeChange={(nextMode) => void changeActiveChatSettings({ mode: nextMode }, "요청 모드를")}
          onApprovalModeChange={(nextMode) => void changeActiveChatSettings({ approvalMode: nextMode }, "승인 처리를")}
          onModelChange={(nextModel) => void changeActiveChatSettings({ model: nextModel }, "응답 모델을")}
          onReasoningEffortChange={(nextEffort) => void changeActiveChatSettings({ reasoningEffort: nextEffort }, "추론 수준을")}
          onExtraSettingsApply={(nextSettings) => void changeActiveChatSettings({ extraSettings: nextSettings }, "추가 설정을")}
        />
        <ChatComposer
          ariaLabel="채팅 메시지"
          value={composer}
          attachments={composerAttachments}
          uploading={uploadingAttachments}
          busy={chatBusy}
          canCompose={composerUsable && !uploadingAttachments}
          rows={1}
          placeholder={phase === "ready" ? "메시지를 입력하거나 파일을 첨부하세요" : phase === "waitingApproval" ? "승인 대기 중입니다. 전송하면 대기열에 추가됩니다" : chatBusy ? "응답 중입니다. 전송하면 대기열에 추가됩니다" : "채팅이 종료되었습니다. 새 채팅을 시작하세요"}
          queue={queue}
          onChange={(value) => { composerRef.current = value; setComposer(value); }}
          onAddFiles={addComposerFiles}
          onRemoveAttachment={removeComposerAttachment}
          onSubmit={send}
          onQueue={() => void deliverComposer(false)}
          onSteer={() => void deliverComposer(true)}
          onInterrupt={() => void interrupt()}
          onRemoveQueued={(messageId) => void removeQueued(messageId)}
          onRecallQueued={(item) => void recallQueued(item)}
        />
        </section>
      </section>
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </div>
  );
}

function ActivityLog({ turns, chatId, filter, onFilter, onDecision, onOpenLocalLink }: { turns: ChatTurn[]; chatId: string | null; filter: ActivityFilter; onFilter: (filter: ActivityFilter) => void; onDecision: (id: string, decision: ChatApprovalDecision) => void; onOpenLocalLink: (href: string) => void }) {
  return (
    <div className="activity-log">
      <header><strong>요청별 작업 로그</strong><select value={filter} onChange={(event) => onFilter(event.target.value as ActivityFilter)}><option value="all">전체</option><option value="tool">도구 실행</option><option value="reasoning">진행 상황</option><option value="error">오류·승인</option></select></header>
      {turns.length === 0 ? <EmptyState title="작업 로그가 없습니다" /> : turns.map((turn) => {
        const entries = turn.entries.filter((entry) => activityMatches(entry, filter));
        if (entries.length === 0) return null;
        const userEntry = turn.entries.find((entry): entry is Extract<ChatEntry, { type: "message" }> => entry.type === "message" && entry.role === "user");
        const title = userEntry?.text.slice(0, 80) || userEntry?.attachments[0]?.name || "시스템 작업";
        return <section className="activity-turn" key={turn.id}><header><span className={`chat-tool-state chat-tool-state-${turn.status}`} /><strong>{title}</strong><time>{chatTurnStatusLabel(turn.status)} · {formatDate(turn.startedAt)}</time></header><div>{entries.map((entry) => <ChatEntryView entry={entry} chatId={chatId} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} key={`${entry.type}-${entry.id}`} />)}</div></section>;
      })}
    </div>
  );
}

function SchedulesPanel({ providers, accounts, projects, models, sessions, currentSession, currentPrompt, onOpenSession }: { providers: ProviderStatus[]; accounts: AccountSnapshot | null; projects: ProjectOption[]; models: ModelOption[]; sessions: SessionSummary[]; currentSession: ChatSessionInfo | null; currentPrompt: string; onOpenSession: (session: SessionSummary) => void }) {
  const [snapshot, setSnapshot] = useState<SchedulerSnapshot | null>(null);
  const [editing, setEditing] = useState<ScheduledRequest | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runActionId, setRunActionId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<Record<string, string>>({});
  const editorRef = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await getSchedulerSnapshot();
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 15_000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      editorRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);
  const act = async (action: () => Promise<unknown>) => { setError(null); try { await action(); await refresh(); } catch (cause) { setError(errorMessage(cause)); } };
  const cancelRun = async (run: ScheduleRun, source: ProviderId, transitionId?: string) => {
    const composite = Boolean(transitionId);
    const warning = composite
      ? "실행 중 런타임을 중지하고, run/transition 소유권을 검증한 뒤 이전 활성 계정 복원을 시도합니다. 계속할까요?"
      : "이 반복 실행을 취소할까요? 실행 중 런타임이 있으면 안전하게 종료합니다.";
    if (!window.confirm(warning)) return;
    setRunActionId(run.id);
    setError(null);
    try {
      if (transitionId) {
        const receipt = await cancelAndRecoverScheduledRun(
          { provider: source, runId: run.id, transitionId },
          "스케줄러 UI에서 운영자가 취소 및 계정 전환 복구를 요청했습니다",
        );
        const recovery = receipt.recovery;
        setRunResults((current) => ({
          ...current,
          [run.id]: receipt.partialFailure
            ? `부분 실패 · ${recovery?.recoveryError ?? receipt.cancellation.stopError ?? "전환 lease가 남았습니다"}`
            : recovery?.alreadyRecovered
              ? "취소 완료 · 계정 전환은 이미 복구됨"
              : "취소 완료 · 이전 활성 계정 복원 및 전환 lease 정리 완료",
        }));
      } else {
        const receipt = await cancelScheduledRun(run.id, "스케줄러 UI에서 운영자가 실행 취소를 요청했습니다");
        setRunResults((current) => ({
          ...current,
          [run.id]: receipt.alreadyTerminal ? "이미 terminal 상태입니다" : receipt.stopError ? `취소 영속화 완료 · 런타임 종료 확인 실패: ${receipt.stopError}` : "취소 완료",
        }));
      }
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunActionId(null);
    }
  };
  return (
    <section className="schedules-panel">
      <header><div><h2>반복 요청</h2><p>로그인 후 백그라운드에서 에이전트 요청을 실행합니다.</p></div><div>{snapshot && <button className={snapshot.paused ? "button primary" : "button"} type="button" onClick={() => act(() => setSchedulesPaused(!snapshot.paused))}>{snapshot.paused ? "전체 재개" : "전체 일시정지"}</button>}<button className="button primary" type="button" onClick={() => setEditing("new")}>새 반복 요청</button></div></header>
      {error && <ErrorBanner message={error} />}
      {snapshot && !snapshot.runnerActive && <div className="warning-banner">다른 Agent Manager 프로세스가 반복 실행을 담당하고 있습니다.</div>}
      {editing && <div className="schedule-editor-anchor" ref={editorRef}><ScheduleEditor key={editing === "new" ? "new" : editing.id} providers={providers} accounts={accounts} projects={projects} models={models} currentSession={currentSession} initialPrompt={currentPrompt} schedule={editing === "new" ? undefined : editing} onSaved={() => { setEditing(null); void refresh(); }} onCancel={() => setEditing(null)} /></div>}
      {!snapshot ? <div className="state-panel"><span className="spinner" /><p>반복 요청을 읽고 있습니다.</p></div> : snapshot.schedules.length === 0 ? <EmptyState title="등록된 반복 요청이 없습니다" detail="이 탭에서 새 반복 작업을 만드세요." /> : (
        <div className="schedule-list">{snapshot.schedules.map((schedule) => {
          const runs = snapshot.runs.filter((run) => run.scheduleId === schedule.id);
          const last = runs[0];
          const activeRun = runs.find((run) => run.status === "running" || run.status === "waitingForAccount");
          const scheduleAccount = accounts?.accounts.find((account) => account.id === schedule.accountId);
          const scheduleProviderState = accounts?.providers.find((state) => state.provider === schedule.source);
          const actualActiveAccountId = scheduleProviderState?.observedActiveAccountId
            ?? scheduleProviderState?.activeAccountId
            ?? null;
          const scheduleAccountIsActual = schedule.accountId === actualActiveAccountId;
          const scheduleAccountIsRegistrySelected = schedule.accountId === scheduleProviderState?.activeAccountId;
          const queued = Boolean(schedule.manualRunRequestedAt) && !activeRun;
          const status = !schedule.enabled ? "paused" : activeRun?.status === "waitingForAccount" ? "waitingForAccount" : activeRun ? "running" : queued ? "requested" : last?.status ?? "idle";
          const statusLabel = !schedule.enabled ? "일시정지" : activeRun ? runStatusLabel(activeRun.status) : queued ? "실행 요청됨" : last ? runStatusLabel(last.status) : "대기";
          return <article className={`schedule-card ${schedule.enabled ? "" : "disabled"}`} key={schedule.id}><header><SourceBadge source={schedule.source} /><div><strong>{schedule.name}</strong><small>{schedule.prompt}</small></div><span className={`schedule-status ${status}`}>{statusLabel}</span></header><div className="schedule-meta"><span>계정 {scheduleAccount?.displayName ?? schedule.accountId}</span><span>{scheduleAccountIsActual ? "CLI 실제 활성" : scheduleAccountIsRegistrySelected ? "Agent Manager 선택 · CLI 불일치" : schedule.autoSwitchWhenIdle ? (schedule.forceSessionCleanup ? "세션 정리 후 자동 전환" : "유휴 시 자동 전환") : "수동 전환 대기"}</span><span>{permissionModeLabel(schedule.mode)}</span><span>{approvalModeLabel(effectiveApprovalMode(schedule.source, schedule.approvalMode ?? "never"))}</span>{schedule.reasoningEffort && <span>추론 {reasoningLabel(schedule.reasoningEffort)}</span>}<span>{schedule.sessionStrategy === "continue" ? `동일 대화 · ${resumePolicyLabel(schedule.resumeFailurePolicy)}` : "매번 새 채팅"}</span><span>다음 {schedule.enabled ? formatRelative(schedule.nextRunAt) : "–"}</span></div><footer><button className="button" type="button" disabled={Boolean(activeRun) || queued} onClick={() => act(() => runScheduledRequestNow(schedule.id))}>{activeRun ? runStatusLabel(activeRun.status) : queued ? "실행 요청됨" : "지금 실행"}</button><button className="button" type="button" onClick={() => act(() => setScheduleEnabled(schedule.id, !schedule.enabled))}>{schedule.enabled ? "일시정지" : "활성화"}</button><button className="button" type="button" onClick={() => setEditing(schedule)}>수정</button><button className="button danger-subtle" type="button" onClick={() => { if (window.confirm(`'${schedule.name}' 반복 요청을 삭제할까요? 공급자 대화는 유지됩니다.`)) void act(() => deleteScheduledRequest(schedule.id)); }}>삭제</button></footer>{runs.length > 0 && <ScheduleRunHistory runs={runs} source={schedule.source} sessions={sessions} providerState={scheduleProviderState} actionRunId={runActionId} results={runResults} onCancel={cancelRun} onOpenSession={onOpenSession} />}</article>;
        })}</div>
      )}
    </section>
  );
}

function ScheduleRunHistory({ runs, source, sessions, providerState, actionRunId, results, onCancel, onOpenSession }: { runs: ScheduleRun[]; source: ProviderId; sessions: SessionSummary[]; providerState: AccountSnapshot["providers"][number] | undefined; actionRunId: string | null; results: Record<string, string>; onCancel: (run: ScheduleRun, source: ProviderId, transitionId?: string) => Promise<void>; onOpenSession: (session: SessionSummary) => void }) {
  return <section className="schedule-run-history">{runs.map((run, index) => <ScheduleRunView key={run.id} run={run} source={source} sessions={sessions} providerState={providerState} busy={actionRunId === run.id} result={results[run.id]} onCancel={onCancel} onOpenSession={onOpenSession} label={index === 0 ? "최근 실행" : "이전 실행"} />)}</section>;
}

function ScheduleRunView({ run, source, sessions, providerState, busy, result, onCancel, onOpenSession, label }: { run: ScheduleRun; source: ProviderId; sessions: SessionSummary[]; providerState: AccountSnapshot["providers"][number] | undefined; busy: boolean; result?: string; onCancel: (run: ScheduleRun, source: ProviderId, transitionId?: string) => Promise<void>; onOpenSession: (session: SessionSummary) => void; label: string }) {
  const session = run.providerSessionId ? sessions.find((item) => item.source === source && item.id === run.providerSessionId) : null;
  const active = run.status === "running" || run.status === "waitingForAccount";
  const transition = providerState?.transition;
  const transitionId = run.transitionId ?? (run.accountSwitched && transition?.previousActiveAccountId === run.previousActiveAccountId && transition.targetAccountId === run.actualAccountId ? transition.transitionId : undefined);
  const heartbeatAge = run.lastHeartbeatAt ? Math.max(0, Math.floor((Date.now() - run.lastHeartbeatAt) / 1000)) : null;
  return <details className="schedule-run" open={active}><summary><span>{label} · {formatDate(run.startedAt ?? run.scheduledFor)}</span><em className={run.status}>{runStatusLabel(run.status)}</em></summary><div>{run.status === "running" && <p>에이전트 응답을 기다리고 있습니다.</p>}{run.status === "waitingForAccount" && <p>선택한 계정을 사용할 수 있도록 공급자 런타임 종료 또는 수동 전환을 기다립니다.</p>}{run.accountSwitched && <p>실행 계정으로 임시 전환 · 종료 후 이전 활성 계정 {run.previousActiveAccountId ?? "–"} 복원</p>}{active && <p className="schedule-run-evidence">stale 판정 근거 · providerSessionId {run.providerSessionId ? "있음" : "없음"} · heartbeat {heartbeatAge === null ? "없음" : `${heartbeatAge}초 전`} · runtimeCount {providerState?.runtimeCount ?? "알 수 없음"} · transition {transitionId ? "identity 확인됨" : providerState?.transitionInProgress ? "identity 불일치" : "없음"}</p>}{run.sessionReplaced && <p>대화 재개 실패 후 새 세션으로 전환됨 · 재시도 {run.retryCount}회</p>}{run.summary && <pre>{run.summary}</pre>}{run.error && <p className="schedule-run-error">{run.error}</p>}{run.recoveryError && <p className="schedule-run-error">복구 오류: {run.recoveryError}</p>}{result && <p className="schedule-run-result">{result}</p>}<div className="schedule-run-actions">{active && <button className="button danger-subtle" type="button" disabled={busy} onClick={() => void onCancel(run, source)}>{busy ? "처리 중…" : "실행 취소"}</button>}{transitionId && (active || providerState?.transitionInProgress) && <button className="button danger-subtle" type="button" disabled={busy} onClick={() => void onCancel(run, source, transitionId)}>{busy ? "처리 중…" : active ? "취소 및 전환 복구" : "전환 복구 재시도"}</button>}{session && <button className="button" type="button" onClick={() => onOpenSession(session)}>결과 세션 열기</button>}</div></div></details>;
}

function ScheduleEditor({ providers, accounts, projects, models, currentSession, initialPrompt, schedule, onSaved, onCancel }: { providers: ProviderStatus[]; accounts: AccountSnapshot | null; projects: ProjectOption[]; models: ModelOption[]; currentSession: ChatSessionInfo | null; initialPrompt: string; schedule?: ScheduledRequest; onSaved: () => void; onCancel: () => void }) {
  const initialSource = schedule?.source ?? currentSession?.source ?? providers[0]?.provider ?? "codex";
  const initialProviderState = accounts?.providers.find((state) => state.provider === initialSource);
  const initialAccountId = schedule?.accountId
    ?? (currentSession?.source === initialSource ? currentSession.accountId : null)
    ?? initialProviderState?.observedActiveAccountId
    ?? initialProviderState?.activeAccountId
    ?? accounts?.accounts.find((account) => account.provider === initialSource && !account.disabled)?.id
    ?? "";
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? initialPrompt);
  const [source, setSource] = useState<ProviderId>(initialSource);
  const [accountId, setAccountId] = useState(initialAccountId);
  const [autoSwitchWhenIdle, setAutoSwitchWhenIdle] = useState(schedule?.autoSwitchWhenIdle ?? false);
  const [forceSessionCleanup, setForceSessionCleanup] = useState(schedule?.forceSessionCleanup ?? false);
  const [cwd, setCwd] = useState(schedule?.cwd ?? currentSession?.cwd ?? projects[0]?.path ?? "");
  const [model, setModel] = useState(schedule?.model ?? currentSession?.model ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(schedule?.reasoningEffort ?? currentSession?.reasoningEffort ?? "");
  const [mode, setMode] = useState<ChatMode>(schedule?.mode ?? currentSession?.mode ?? "workspace");
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode>(effectiveApprovalMode(initialSource, schedule?.approvalMode ?? currentSession?.approvalMode ?? defaultApprovalMode(initialSource)));
  const [frequency, setFrequency] = useState<ScheduleFrequency>(schedule?.recurrence.frequency ?? "daily");
  const [interval, setIntervalValue] = useState(schedule?.recurrence.interval ?? 1);
  const [hour, setHour] = useState(schedule?.recurrence.hour ?? 9);
  const [minute, setMinute] = useState(schedule?.recurrence.minute ?? 0);
  const [weekday, setWeekday] = useState(schedule?.recurrence.weekday ?? 1);
  const [cron, setCron] = useState(schedule?.recurrence.cron ?? "0 9 * * 1-5");
  const [strategy, setStrategy] = useState(schedule?.sessionStrategy ?? "newChat");
  const [failurePolicy, setFailurePolicy] = useState<ResumeFailurePolicy>(schedule?.resumeFailurePolicy ?? "retryThenNewChat");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [loginStart, setLoginStart] = useState(true);
  const [fullAccessAcknowledged, setFullAccessAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerOptions = useProviderOptions(source);
  const providerAccounts = accounts?.accounts.filter((account) => account.provider === source && !account.disabled && account.authStatus === "ready") ?? [];
  const providerState = accounts?.providers.find((state) => state.provider === source);
  const actualActiveAccountId = providerState?.observedActiveAccountId
    ?? providerState?.activeAccountId
    ?? null;
  const recentModels = models.filter((item) => item.source === source);
  const reasoningOptions = reasoningOptionsFor(providerOptions, model);
  const timezone = schedule?.recurrence.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  useEffect(() => {
    if (hasTauriRuntime()) void getBackgroundSettings().then((settings) => setLoginStart(schedule ? settings.loginStart : true)).catch(() => undefined);
  }, [schedule]);
  useEffect(() => {
    // 카탈로그 로딩 중(options 비어 있음)에는 저장된 값을 지우지 않는다.
    if (reasoningEffort && reasoningOptions.length > 0 && !reasoningOptions.some((option) => option.effort === reasoningEffort)) setReasoningEffort("");
  }, [reasoningEffort, reasoningOptions]);
  const previousSource = useRef(source);
  useEffect(() => {
    if (previousSource.current === source) return;
    previousSource.current = source;
    setModel("");
    setReasoningEffort("");
    setApprovalMode(defaultApprovalMode(source));
    const nextProviderState = accounts?.providers.find((state) => state.provider === source);
    setAccountId(nextProviderState?.observedActiveAccountId
      ?? nextProviderState?.activeAccountId
      ?? accounts?.accounts.find((account) => account.provider === source && !account.disabled && account.authStatus === "ready")?.id
      ?? "");
  }, [accounts, source]);
  useEffect(() => {
    if (accountId) return;
    setAccountId(providerState?.observedActiveAccountId
      ?? providerState?.activeAccountId
      ?? accounts?.accounts.find((account) => account.provider === source && !account.disabled && account.authStatus === "ready")?.id
      ?? "");
  }, [accountId, accounts, providerState, source]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "fullAccess" && !fullAccessAcknowledged) return;
    const input: ScheduledRequestInput = { name: name.trim() || prompt.trim().slice(0, 60), prompt, source, accountId, autoSwitchWhenIdle, forceSessionCleanup: autoSwitchWhenIdle && forceSessionCleanup, cwd, model: model.trim() || null, reasoningEffort: reasoningEffort || null, mode, approvalMode, recurrence: { frequency, interval, hour, minute, weekday, cron: frequency === "cron" ? cron : null, timezone }, sessionStrategy: strategy, resumeFailurePolicy: failurePolicy, providerSessionId: strategy === "continue" ? schedule?.providerSessionId ?? (currentSession?.source === source ? currentSession.providerSessionId : null) : null, enabled };
    setSaving(true); setError(null);
    try { if (schedule) await updateScheduledRequest(schedule.id, input); else await createScheduledRequest(input); if (hasTauriRuntime()) await setBackgroundSettings(loginStart); onSaved(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };
  return <form className="schedule-editor" onSubmit={submit}><header><div><strong>{schedule ? "반복 요청 수정" : "새 반복 요청"}</strong><span>{timezone}</span></div><button type="button" onClick={onCancel} aria-label="닫기"><X size={16} /></button></header><div className="schedule-editor-grid"><label><span>이름</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="비워두면 요청 앞부분 사용" /></label><label><span>공급자</span><select value={source} onChange={(event) => setSource(event.target.value as ProviderId)}>{providers.map((provider) => <option value={provider.provider} key={provider.provider}>{provider.displayName}</option>)}</select></label><label><span>실행 계정</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)} required><option value="" disabled>계정 선택</option>{providerAccounts.map((account) => <option value={account.id} key={account.id}>{account.displayName}{account.id === actualActiveAccountId ? " · CLI 실제 활성" : account.isActive ? " · Agent Manager 선택" : ""}</option>)}</select></label><label className="check-filter"><input type="checkbox" checked={autoSwitchWhenIdle} onChange={(event) => setAutoSwitchWhenIdle(event.target.checked)} /> 유휴 시 자동 전환</label>{autoSwitchWhenIdle && <label className="check-filter"><input type="checkbox" checked={forceSessionCleanup} onChange={(event) => setForceSessionCleanup(event.target.checked)} /> 전환이 막히면 실행 중 세션 강제 종료</label>}<label className="wide"><span>반복할 요청</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} required /></label><label className="wide"><span>작업 경로</span><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/project/path" required list="schedule-projects" /><datalist id="schedule-projects">{projects.map((project) => <option value={project.path} key={project.path}>{project.name}</option>)}</datalist></label><RuntimeSettings source={source} mode={mode} onModeChange={(nextMode) => { setMode(nextMode); setFullAccessAcknowledged(false); }} approvalMode={approvalMode} onApprovalModeChange={setApprovalMode} model={model} onModelChange={setModel} catalog={providerOptions} recent={recentModels} reasoningEffort={reasoningEffort} onReasoningChange={setReasoningEffort} reasoningOptions={reasoningOptions} defaultEffort={defaultEffortFor(providerOptions, model)} compact unattended /><label><span>주기</span><select value={frequency} onChange={(event) => setFrequency(event.target.value as ScheduleFrequency)}><option value="hourly">매 N시간</option><option value="daily">매일</option><option value="weekdays">평일</option><option value="weekly">매주</option><option value="cron">고급 Cron</option></select></label>{frequency === "hourly" && <label><span>간격</span><input type="number" min={1} max={168} value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))} /></label>}{frequency !== "hourly" && frequency !== "cron" && <label><span>실행 시각</span><div className="time-fields"><input type="number" min={0} max={23} value={hour} onChange={(event) => setHour(Number(event.target.value))} /><b>:</b><input type="number" min={0} max={59} value={minute} onChange={(event) => setMinute(Number(event.target.value))} /></div></label>}{frequency === "weekly" && <label><span>요일</span><select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>{["일", "월", "화", "수", "목", "금", "토"].map((label, index) => <option value={index} key={label}>{label}요일</option>)}</select></label>}{frequency === "cron" && <label className="wide"><span>Cron · 분 시 일 월 요일</span><input value={cron} onChange={(event) => setCron(event.target.value)} placeholder="0 9 * * 1-5" /></label>}<label><span>세션 방식</span><select value={strategy} onChange={(event) => setStrategy(event.target.value as "newChat" | "continue")}><option value="newChat">매번 새 채팅</option><option value="continue">동일 대화 이어가기</option></select></label>{strategy === "continue" && <label><span>재개 실패 시</span><select value={failurePolicy} onChange={(event) => setFailurePolicy(event.target.value as ResumeFailurePolicy)}><option value="pause">작업 일시정지</option><option value="newChat">즉시 새 대화</option><option value="retryThenNewChat">한 번 재시도 후 새 대화</option></select></label>}<label className="check-filter"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 저장 후 활성화</label>{mode === "fullAccess" && <label className="check-filter wide"><input type="checkbox" checked={fullAccessAcknowledged} onChange={(event) => setFullAccessAcknowledged(event.target.checked)} /> 전체 접근 반복 요청은 작업 경로 밖 명령도 무인으로 실행될 수 있음을 이해했습니다</label>}{hasTauriRuntime() && <label className="check-filter"><input type="checkbox" checked={loginStart} onChange={(event) => setLoginStart(event.target.checked)} /> 로그인 시 백그라운드 실행</label>}</div>{providerAccounts.length === 0 && <ErrorBanner message="선택한 공급자에 사용 가능한 계정이 없습니다. 설정에서 계정을 추가하세요." />}{error && <ErrorBanner message={error} />}<footer><button className="button" type="button" onClick={onCancel}>취소</button><button className="button primary" type="submit" disabled={saving || !accountId || !prompt.trim() || !cwd.trim() || (mode === "fullAccess" && !fullAccessAcknowledged)}>{saving ? "저장 중…" : "저장"}</button></footer></form>;
}

function ModelPicker({ value, onChange, catalog, recent }: { value: string; onChange: (value: string) => void; catalog: ChatProviderOptions | null; recent: ModelOption[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setQuery("");
    listRef.current?.scrollTo({ top: 0 });
  }, [catalog?.source]);
  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: 0 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const modelMap = new Map<string, ChatModelCatalogOption>();
  for (const option of catalog?.models ?? []) modelMap.set(option.model, option);
  for (const item of recent) {
    if (!modelMap.has(item.model)) modelMap.set(item.model, { model: item.model, displayName: item.model, description: "최근 세션에서 사용한 모델", isDefault: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] });
  }
  const selected = value ? modelMap.get(value) : catalog?.models.find((option) => option.isDefault);
  const countByModel = new Map(recent.map((item) => [item.model, item.count]));
  const normalized = query.trim().toLowerCase();
  const visible = [...modelMap.values()].filter((option) => !normalized || `${option.displayName} ${option.model} ${option.description}`.toLowerCase().includes(normalized));
  const exact = [...modelMap.values()].some((option) => option.model.toLowerCase() === normalized);
  const choose = (next: string) => { onChange(next); setQuery(""); setOpen(false); };
  return (
    <div className="model-picker-field form-field" ref={rootRef}>
      <span className="field-label">모델 {!catalog && <small>불러오는 중</small>}</span>
      <button className="model-picker-trigger" type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span><strong>{value ? selected?.displayName ?? value : "공급자 기본값"}</strong><small>{value || selected?.model || "CLI 설정을 그대로 사용"}</small></span><b><ChevronDown size={15} aria-hidden="true" /></b>
      </button>
      {open && <div className="model-picker-popover">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="모델 이름 검색 또는 식별자 입력" autoFocus />
        <div className="model-picker-list" role="listbox" ref={listRef}>
          {!normalized && <button className={!value ? "selected" : ""} type="button" role="option" aria-selected={!value} onClick={() => choose("")}><span><strong>공급자 기본값</strong><small>{catalog?.models.find((option) => option.isDefault)?.displayName ?? "CLI 기본 설정"}</small></span><em>{!value ? <><Check size={10} /> 선택됨</> : "권장"}</em></button>}
          {visible.map((option) => <button className={value === option.model ? "selected" : ""} type="button" role="option" aria-selected={value === option.model} key={option.model} onClick={() => choose(option.model)}><span><strong>{option.displayName}</strong><small>{option.model}{option.description ? ` · ${option.description}` : ""}</small></span><em>{value === option.model ? <><Check size={10} /> 선택됨</> : option.isDefault ? "기본" : countByModel.has(option.model) ? `최근 ${countByModel.get(option.model)}회` : "사용 가능"}</em></button>)}
          {normalized && !exact && <button className="model-picker-manual" type="button" onClick={() => choose(query.trim())}><span><strong>‘{query.trim()}’ 직접 사용</strong><small>CLI에 모델 식별자를 그대로 전달합니다</small></span><em>직접 입력</em></button>}
          {visible.length === 0 && (!normalized || exact) && <p>일치하는 모델이 없습니다.</p>}
        </div>
        {catalog?.catalogError && <small className="model-catalog-warning">실시간 목록을 불러오지 못해 최근 모델만 표시합니다.</small>}
      </div>}
    </div>
  );
}

interface RuntimeSettingsProps {
  source: ProviderId;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  approvalMode: ChatApprovalMode;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  model: string;
  onModelChange: (model: string) => void;
  catalog: ChatProviderOptions | null;
  recent: ModelOption[];
  reasoningEffort: ReasoningEffort | "";
  onReasoningChange: (effort: ReasoningEffort | "") => void;
  reasoningOptions: ChatReasoningOption[];
  defaultEffort: ReasoningEffort | null;
  compact?: boolean;
  unattended?: boolean;
  extraSettings?: Record<string, string>;
  onExtraSettingChange?: (key: string, value: string) => void;
}

// mode·approvalMode·모델·추론은 전용 UI가 있으므로, 그 외 스키마 항목만 일반 렌더러로 그린다.
const BUILTIN_SETTING_KEYS = new Set(["mode", "approvalMode", "model", "reasoningEffort"]);

function RuntimeSettings({ source, mode, onModeChange, approvalMode, onApprovalModeChange, model, onModelChange, catalog, recent, reasoningEffort, onReasoningChange, reasoningOptions, defaultEffort, compact = false, unattended = false, extraSettings, onExtraSettingChange }: RuntimeSettingsProps) {
  const fields = settingFieldsFor(catalog, source);
  const extraFields = onExtraSettingChange ? fields.filter((field) => !BUILTIN_SETTING_KEYS.has(field.key)) : [];
  return (
    <fieldset className={`runtime-settings${compact ? " compact" : ""}`}>
      <legend><span>실행 설정</span><small>권한 · 승인 · 모델 · 추론</small></legend>
      <ModeField mode={mode} onChange={onModeChange} field={settingField(fields, "mode")} />
      <ApprovalField source={source} mode={mode} value={approvalMode} onChange={onApprovalModeChange} unattended={unattended} field={settingField(fields, "approvalMode")} />
      <div className="runtime-model-row">
        <ModelPicker value={model} onChange={onModelChange} catalog={catalog} recent={recent} />
        <ReasoningField value={reasoningEffort} onChange={onReasoningChange} options={reasoningOptions} defaultEffort={defaultEffort} />
      </div>
      {extraFields.length > 0 && <div className="runtime-model-row">
        {extraFields.map((field) => <ExtraSettingField field={field} value={extraSettings?.[field.key] ?? ""} onChange={(value) => onExtraSettingChange?.(field.key, value)} key={field.key} />)}
      </div>}
    </fieldset>
  );
}

function ExtraSettingField({ field, value, onChange }: { field: ChatSettingField; value: string; onChange: (value: string) => void }) {
  if (field.kind === "enum") {
    return <label className="reasoning-field"><span className="field-label">{field.label} {field.detail ? <small>{field.detail}</small> : <small>선택</small>}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">기본값</option>{field.options.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}</select></label>;
  }
  return <label className="reasoning-field"><span className="field-label">{field.label} <small>선택</small></span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.detail ?? ""} /></label>;
}

function ApprovalField({ source, mode, value, onChange, unattended, field }: { source: ProviderId; mode: ChatMode; value: ChatApprovalMode; onChange: (mode: ChatApprovalMode) => void; unattended: boolean; field: ChatSettingField | null }) {
  // "직접 승인"의 설명은 실행 맥락(무인 여부)에 따라 달라지므로 스키마 값을 덮어쓴다.
  const options = (field?.options ?? []).map((option) =>
    option.value === "manual" && unattended ? { ...option, detail: "요청 시 거절" } : option);
  return <div className="approval-field"><span className="field-label">{field?.label ?? "승인 처리"} <small>{field?.detail ?? "명령 · 파일 · 추가 권한"}</small></span><div className="mode-options approval-options" role="group" aria-label={field?.label ?? "승인 처리"}>{options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" aria-pressed={value === option.value} disabled={option.disabled} onClick={() => onChange(option.value as ChatApprovalMode)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>{approvalModeDescription(source, mode, value, unattended)}</div>;
}

function approvalModeDescription(source: ProviderId, mode: ChatMode, approvalMode: ChatApprovalMode, unattended: boolean) {
  if (approvalMode === "autoReview") return <small className="approval-mode-hint">Codex 검토 에이전트가 승인 요청을 평가하며 추가 사용량이 발생할 수 있습니다.</small>;
  if (approvalMode === "never" && mode === "fullAccess") return <small className="chat-permission-warning" role="alert">샌드박스와 승인 절차 없이 모든 명령을 실행합니다.</small>;
  if (approvalMode === "never") return <small className="approval-mode-warning" role="alert">승인 요청 없이 현재 권한 범위에서만 실행하며, 범위를 벗어난 작업은 실패합니다.</small>;
  if (unattended) return <small className="approval-mode-warning">백그라운드 실행은 직접 승인할 수 없어 추가 권한 요청을 거절합니다.</small>;
  return <small className="approval-mode-hint">{source === "claude" ? "Claude가 추가 권한을 요청하면 실행을 멈추고 직접 확인합니다." : "추가 권한이 필요하면 실행을 멈추고 직접 확인합니다."}</small>;
}

function ReasoningField({ value, onChange, options, defaultEffort }: { value: ReasoningEffort | ""; onChange: (value: ReasoningEffort | "") => void; options: ChatReasoningOption[]; defaultEffort: ReasoningEffort | null }) {
  const selected = options.find((option) => option.effort === value);
  return <label className="reasoning-field"><span className="field-label">추론 수준 <small>선택</small></span><select value={value} onChange={(event) => onChange(event.target.value as ReasoningEffort | "")}><option value="">공급자 기본값{defaultEffort ? ` · ${reasoningLabel(defaultEffort)}` : ""}</option>{options.map((option) => <option value={option.effort} key={option.effort}>{reasoningLabel(option.effort)} · {option.description}</option>)}</select><small>{selected?.description ?? "모델과 공급자의 기본 추론 수준을 사용합니다."}</small></label>;
}

const CHAT_LAUNCH_SETTINGS_KEY = "agent-manager.chat-launch-settings";

interface ChatLaunchSettings {
  model: string;
  reasoningEffort: ReasoningEffort | "";
}

function readChatLaunchSettings(source: ProviderId): ChatLaunchSettings {
  if (typeof window === "undefined") return { model: "", reasoningEffort: "" };
  try {
    const stored = JSON.parse(window.localStorage.getItem(CHAT_LAUNCH_SETTINGS_KEY) ?? "null") as
      | Record<string, Partial<ChatLaunchSettings>>
      | null;
    const entry = stored?.[source];
    return {
      model: typeof entry?.model === "string" ? entry.model : "",
      reasoningEffort: typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : "",
    };
  } catch {
    return { model: "", reasoningEffort: "" };
  }
}

function saveChatLaunchSettings(source: ProviderId, settings: ChatLaunchSettings) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(CHAT_LAUNCH_SETTINGS_KEY) ?? "null") as
      | Record<string, Partial<ChatLaunchSettings>>
      | null;
    window.localStorage.setItem(CHAT_LAUNCH_SETTINGS_KEY, JSON.stringify({ ...stored, [source]: settings }));
  } catch { /* 로컬 저장 실패는 다음 실행에서 기본값을 쓰면 된다. */ }
}

function defaultEffortFor(catalog: ChatProviderOptions | null, model: string): ReasoningEffort | null {
  if (!catalog) return null;
  const selected = model ? catalog.models.find((option) => option.model === model) : catalog.models.find((option) => option.isDefault);
  return selected?.defaultReasoningEffort ?? catalog.defaultReasoningEffort;
}

function ModeField({ mode, onChange, field }: { mode: ChatMode; onChange: (mode: ChatMode) => void; field: ChatSettingField | null }) {
  return <div className="mode-field"><span className="field-label">{field?.label ?? "실행 모드"} <small>{field?.detail ?? "권한 범위"}</small></span><div className="mode-options" role="group" aria-label={field?.label ?? "실행 모드"}>{(field?.options ?? []).map((option) => <button className={mode === option.value ? "selected" : ""} type="button" aria-pressed={mode === option.value} disabled={option.disabled} onClick={() => onChange(option.value as ChatMode)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>{mode === "fullAccess" && <small className="chat-permission-warning" role="alert">작업 경로 밖의 명령과 파일 접근까지 허용합니다.</small>}</div>;
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
function phaseLabel(phase: ChatPhase | "connecting"): string { return phase === "connecting" ? "연결 중" : phase === "ready" ? "입력 대기" : phase === "running" ? "응답 중" : phase === "waitingApproval" ? "승인 대기" : phase === "stopped" ? "종료됨" : "오류"; }
function runStatusLabel(status: ScheduleRun["status"]): string { return status === "completed" ? "완료" : status === "failed" ? "실패" : status === "cancelled" ? "취소됨" : status === "skipped" ? "건너뜀" : status === "waitingForAccount" ? "계정 전환 대기" : "실행 중"; }
function resumePolicyLabel(policy: ResumeFailurePolicy): string { return policy === "pause" ? "실패 시 중지" : policy === "newChat" ? "실패 시 새 대화" : "재시도 후 새 대화"; }
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
