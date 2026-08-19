import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Send, Square, X } from "lucide-react";
import { attachChat, connectChat, removeChatInputFile, type ChatConnection } from "../lib/chat";
import {
  appendAttachmentDrafts,
  AttachmentPicker,
  ChatAttachmentList,
  clipboardFiles,
  queuedAttachmentsToDrafts,
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
import { selectAiaChat } from "../lib/aiaChatSelection";
import { aiaChatsForProvider, aiaRuntimeNeedsRestart, supportsAiaSystemTools } from "../lib/aiaRuntime";
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
import { ChatToolCard } from "./ChatToolCard";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { CopyAction } from "./CopyAction";
import { ChatScrollControls } from "./ChatConversation";
import { SpeechPlaybackAction, VoiceInputControl } from "./VoiceControls";
import { isReadableFinalResponse } from "../lib/voice";
import {
  AiaMark,
  ChatApprovalCard,
  ChatQueueList,
  ErrorBanner,
  type ChatApprovalPrompt,
} from "./Shared";

type AiaEntry =
  | { type: "message"; id: string; role: string; kind: string; text: string; attachments: ChatInputFile[] }
  | { type: "tool"; id: string; name: string; status: string; detail: string; output: string }
  | ({ type: "approval" } & ChatApprovalPrompt)
  | { type: "error"; id: string; text: string };

type AiaTurn = ChatTimelineTurn<AiaEntry>;
type AiaActivityEntry = Extract<AiaEntry, { type: "tool" }> | Extract<AiaEntry, { type: "message" }>;

interface AiaChatPopupProps {
  open: boolean;
  /** 시스템 설정에서 고른 시스템 에이전트. AIA 런타임이 이 공급자로 실행된다. */
  provider: ProviderId;
  providerName: string;
  providerConnected: boolean;
  attentionTarget: AiaAttentionTarget | null;
  autoPrompt: AiaAutoPrompt | null;
  onClose: () => void;
  onConnectProvider: () => void;
  onAttentionTargetHandled: (target: AiaAttentionTarget, opened: boolean) => void;
  onAutoPromptHandled: (prompt: AiaAutoPrompt, sent: boolean) => void;
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

export function AiaChatPopup({ open, provider, providerName, providerConnected, attentionTarget, autoPrompt, onClose, onConnectProvider, onAttentionTargetHandled, onAutoPromptHandled }: AiaChatPopupProps) {
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
  const activeTurnRef = useRef<string | null>(null);
  const startingRef = useRef(false);
  const autoStartedRef = useRef(false);
  const restartingRef = useRef(false);
  const handledAutoPromptRef = useRef(0);
  const streamRef = useRef<HTMLDivElement>(null);
  const followLatestMessagesRef = useRef(true);

  const applySession = useCallback((next: ChatSessionInfo) => {
    setSession(next);
    setPhase(next.state);
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
          title: event.title,
          detail: event.detail ?? "",
          options: event.options,
          interactive: event.interactive,
          resolved: null,
        },
      ]));
      return;
    }
    if (event.type === "approvalResolved") {
      setTurns((current) => current.map((turn) => ({
        ...turn,
        entries: turn.entries.map((entry) => entry.type === "approval" && entry.id === event.id
          ? { ...entry, resolved: event.decision }
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
  }, [applySession]);

  const startConversation = useCallback(async () => {
    if (!providerConnected || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    setTurns([]);
    setQueue([]);
    setPhase("connecting");
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    try {
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
      connectionRef.current = connection;
      applySession(connection.info);
    } catch (cause) {
      setSession(null);
      setError(errorMessage(cause));
      setPhase("failed");
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [applySession, handleEvent, provider, providerConnected]);

  const attachConversation = useCallback(async (chatId: string) => {
    if (startingRef.current) return false;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    setTurns([]);
    setQueue([]);
    setPhase("connecting");
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    try {
      const connection = await attachChat(chatId, (event) => {
        if (generation === generationRef.current) handleEvent(event);
      });
      connectionRef.current = connection;
      applySession(connection.info);
      return true;
    } catch {
      setSession(null);
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [applySession, handleEvent]);

  const restoreOrStartConversation = useCallback(async () => {
    try {
      const liveChats = await getLiveChats("aia");
      // 이전 공급자에 남아 있는 AIA 대화에는 다시 붙지 않는다.
      const selected = selectAiaChat(aiaChatsForProvider(liveChats, provider));
      if (selected && await attachConversation(selected.chatId)) return;
    } catch {
      // A snapshot failure must not prevent AIA from starting a fresh conversation.
    }
    await startConversation();
  }, [attachConversation, provider, startConversation]);

  useEffect(() => {
    if (!open || !providerConnected || attentionTarget || connectionRef.current || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void restoreOrStartConversation();
  }, [attentionTarget, open, providerConnected, restoreOrStartConversation]);

  // 시스템 에이전트를 바꾸면 이전 공급자에서 돌던 AIA를 정지·분리한 뒤 새 공급자로 다시 시작한다.
  useEffect(() => {
    if (!providerConnected || restartingRef.current || startingRef.current) return;
    if (!aiaRuntimeNeedsRestart(session, provider)) return;
    restartingRef.current = true;
    void (async () => {
      try {
        generationRef.current += 1;
        const connection = connectionRef.current;
        connectionRef.current = null;
        activeTurnRef.current = null;
        if (connection) {
          try { await connection.stop(); } catch { /* The provider may already be stopped. */ }
          try { await connection.detach(); } catch { /* The stopped runtime can remain detached. */ }
        }
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
  }, [open, provider, providerConnected, restoreOrStartConversation, session]);

  const switchConversation = useCallback(async (chatId: string): Promise<boolean> => {
    const connected = connectionRef.current;
    if (connected?.info.chatId === chatId) return true;
    if (startingRef.current) return false;

    startingRef.current = true;
    setStarting(true);
    const previousChatId = connected?.info.chatId ?? null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    connectionRef.current = null;
    activeTurnRef.current = null;
    setError(null);
    setTurns([]);
    setQueue([]);
    setAttachments([]);
    setPhase("connecting");

    let detachedPrevious = false;
    try {
      if (connected) {
        await connected.detach();
        detachedPrevious = true;
      }
      const next = await attachChat(chatId, (event) => {
        if (generation === generationRef.current) handleEvent(event);
      });
      connectionRef.current = next;
      applySession(next.info);
      return true;
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
      setError(`${restored ? "기존 AIA 대화는 유지했지만 " : ""}승인 요청 대화로 전환하지 못했습니다: ${errorMessage(cause)}`);
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [applySession, handleEvent]);

  useEffect(() => {
    if (!open || !providerConnected || !attentionTarget || starting) return undefined;
    void switchConversation(attentionTarget.chatId).then((opened) => {
      onAttentionTargetHandled(attentionTarget, opened);
    });
    return undefined;
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

  const linkedFilePreviewOpen = linkedFilePreview.state !== null;
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !linkedFilePreviewOpen) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [linkedFilePreviewOpen, onClose, open]);

  const closeLinkedFilePreview = linkedFilePreview.close;
  useEffect(() => {
    if (!open) closeLinkedFilePreview();
  }, [closeLinkedFilePreview, open]);

  useEffect(() => () => {
    generationRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) void connection.detach();
  }, []);

  const busy = phase === "running" || phase === "waitingApproval";
  const composerUsable = Boolean(session) && (phase === "ready" || busy);
  const pendingApprovals = useMemo(() => turns
    .flatMap((turn) => turn.entries)
    .filter((entry): entry is Extract<AiaEntry, { type: "approval" }> => (
      entry.type === "approval" && entry.interactive && !entry.resolved
    )), [turns]);

  useEffect(() => {
    if (!open || !autoPrompt || handledAutoPromptRef.current >= autoPrompt.requestId) return;
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
        setError(errorMessage(cause));
        onAutoPromptHandled(autoPrompt, false);
      });
  }, [autoPrompt, composerUsable, onAutoPromptHandled, open, providerConnected, restoreOrStartConversation]);

  const addFiles = (files: File[]) => {
    setAttachments((current) => {
      const result = appendAttachmentDrafts(current, files);
      if (result.error) setError(result.error);
      return result.drafts;
    });
  };

  const removeAttachment = (draft: ChatAttachmentDraft) => {
    setAttachments((current) => current.filter((item) => item.key !== draft.key));
    const chatId = connectionRef.current?.info.chatId;
    if (draft.uploaded && draft.ownedUpload && chatId) {
      void removeChatInputFile(chatId, draft.uploaded.id).catch(() => undefined);
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = composer.trim();
    const connection = connectionRef.current;
    if ((!text && attachments.length === 0) || !connection || !composerUsable || uploading) return;
    setError(null);
    setUploading(true);
    try {
      const uploaded = await uploadAttachmentDrafts(connection.info.chatId, attachments, setAttachments);
      await connection.send(text, { attachmentIds: uploaded.flatMap((draft) => draft.uploaded ? [draft.uploaded.id] : []) });
      setComposer("");
      setAttachments([]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setUploading(false);
    }
  };

  const decide = async (approvalId: string, decision: ChatApprovalDecision) => {
    setError(null);
    try {
      await connectionRef.current?.approve(approvalId, decision);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const removeQueued = async (messageId: string) => {
    try {
      await connectionRef.current?.removeQueued(messageId);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const newConversation = async () => {
    generationRef.current += 1;
    const connection = connectionRef.current;
    connectionRef.current = null;
    if (connection) {
      try { await connection.stop(); } catch { /* The provider may already be stopped. */ }
      try { await connection.detach(); } catch { /* The stopped runtime can remain detached. */ }
    }
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
    try {
      await connectionRef.current?.interrupt();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <aside className={`aia-chat-popup${open ? " open" : ""}`} aria-label="AIA 시스템 에이전트" aria-hidden={!open}>
      <header className="aia-chat-header">
        <div className="aia-avatar"><AiaMark size={18} /></div>
        <div><strong>AIA <span>아이아</span></strong><small><i className={`terminal-status terminal-status-${phase}`} />Agent Manager ({providerName})</small></div>
        <div className="aia-header-actions">
          {providerConnected && <button type="button" onClick={() => void newConversation()} disabled={starting} title={session ? "새 AIA 대화" : "AIA 다시 시작"}><RefreshCw size={15} /></button>}
          <button type="button" onClick={onClose} title="AIA 닫기"><X size={17} /></button>
        </div>
      </header>

      {!providerConnected ? (
        <div className="aia-unavailable">
          <AiaMark size={28} />
          <strong>AIA를 시작하려면 {providerName} CLI 연결이 필요합니다.</strong>
          <small>시스템 설정 &gt; 시스템 에이전트에서 다른 공급자를 고를 수도 있습니다.</small>
          <button className="button primary" type="button" onClick={onConnectProvider}>{providerName} 연결</button>
        </div>
      ) : (
        <>
          <div className="aia-chat-stream-shell">
            <div className="aia-chat-stream" aria-live="polite" ref={streamRef}>
              <article className="aia-welcome">
                <strong>안녕하세요, AIA입니다.</strong>
                <p>Agent Manager의 상태를 확인하거나 작업요청·설정변경·세션확인·반복 요청 작성 등 작업명령을 요청할 수 있습니다.</p>
                {!(session ? session.systemTools : supportsAiaSystemTools(provider)) && <p className="aia-capability-warning" role="status">{providerName} CLI는 실행 단위 MCP 설정을 제공하지 않아 이 런타임에서는 시스템 도구를 쓸 수 없습니다. 설정·세션을 직접 조작하려면 시스템 설정에서 Codex 또는 Claude를 고르세요.</p>}
              </article>
              {starting && turns.length === 0 && <div className="aia-connecting"><span className="spin">◌</span> 시스템 인터페이스 연결 중…</div>}
              {turns.map((turn) => <AiaTurnView turn={turn} chatId={session?.chatId ?? null} onDecision={decide} onOpenLocalLink={linkedFilePreview.open} key={turn.id} />)}
              {error && <ErrorBanner message={error} />}
            </div>
            <ChatScrollControls
              targetRef={streamRef}
              onScrollAwayFromLatest={pauseFollowingLatestMessages}
              onScrollToLatest={resumeFollowingLatestMessages}
            />
          </div>
          {pendingApprovals.length > 0 && <div className="aia-approval-dock"><header><strong>시스템 기능 승인</strong><span>검토 후 허용하세요.</span></header>{pendingApprovals.map((prompt) => <ChatApprovalCard prompt={prompt} onDecision={decide} key={prompt.id} />)}</div>}
          <ChatQueueList items={queue} onRemove={(id) => void removeQueued(id)} onRecall={(item) => { void removeQueued(item.id); setComposer(item.text); setAttachments((current) => [...current, ...queuedAttachmentsToDrafts(item.attachments)]); }} />
          <form className="aia-composer" onSubmit={send}>
            <textarea
              aria-label="AIA 메시지 입력"
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
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
            {busy ? <button className="aia-stop" type="button" onClick={() => void interrupt()} title="현재 응답 중단"><Square size={14} /></button> : <button className="aia-send" type="submit" disabled={!composerUsable || uploading || (!composer.trim() && attachments.length === 0)} title={uploading ? "첨부 중…" : "전송"}><Send size={16} /></button>}
          </form>
        </>
      )}
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
    </aside>
  );
}

function AiaTurnView({ turn, chatId, onDecision, onOpenLocalLink }: { turn: AiaTurn; chatId: string | null; onDecision: (id: string, decision: ChatApprovalDecision) => void; onOpenLocalLink: (href: string) => void }) {
  const segments = segmentChatTimeline(turn.entries, isActivity, isVisible, entryKey);
  const running = isRunningTurn(turn.status);
  const lastAssistantMessage = [...turn.entries].reverse().find((entry) => entry.type === "message" && entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text));
  const lastActivity = segments.reduce((latest, segment, index) => segment.type === "activity" ? index : latest, -1);
  return <section className="aia-turn">{segments.map((segment, index) => {
    if (segment.type === "entry") return <AiaEntryView entry={segment.entry} chatId={chatId} copyReady={!running} speechReady={isReadableFinalResponse(turn.status, segment.entry === lastAssistantMessage)} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} key={segment.key} />;
    const entries = segment.entries as AiaActivityEntry[];
    const active = running && index === segments.length - 1;
    const status = active ? "running" : index === lastActivity ? turn.status : "completed";
    return <ChatActivityGroup entries={entries} active={active} status={status} statusText={active ? "작업 중" : "완료"} summary={activitySummary(entries)} entryKey={entryKey} renderEntry={(entry) => <AiaEntryView entry={entry} chatId={chatId} copyReady={!running} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />} key={segment.key} />;
  })}</section>;
}

function AiaEntryView({ entry, chatId, copyReady, speechReady = false, onDecision, onOpenLocalLink }: { entry: AiaEntry; chatId: string | null; copyReady: boolean; speechReady?: boolean; onDecision: (id: string, decision: ChatApprovalDecision) => void; onOpenLocalLink: (href: string) => void }) {
  if (entry.type === "message") {
    const copyable = entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text);
    return <article className={`chat-message chat-message-${entry.role} chat-message-${entry.kind}`}>
      <strong>{entry.kind === "reasoning" ? "AIA 작업" : entry.role === "user" ? "사용자" : "AIA"}</strong>
      {copyable && speechReady && <SpeechPlaybackAction responseId={`aia:${chatId ?? "chat"}:${entry.id}`} text={entry.text} />}
      {copyable && <CopyAction value={entry.text} kind="response" className="message-copy-action" disabled={!copyReady} />}
      {entry.text && <div className="chat-message-markdown"><MarkdownPreview source={entry.text} compact copyable={copyable && copyReady} onOpenLocalLink={onOpenLocalLink} /></div>}
      <ChatAttachmentList chatId={chatId} files={entry.attachments} />
    </article>;
  }
  if (entry.type === "tool") return <ChatToolCard name={entry.name} status={entry.status} detail={entry.detail} output={entry.output} />;
  if (entry.type === "approval") return <ChatApprovalCard prompt={entry} onDecision={onDecision} />;
  return <article className="chat-event-error">{entry.text}</article>;
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
