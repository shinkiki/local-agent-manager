import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import type {
  ChatApprovalDecision,
  ChatEvent,
  ChatInputFile,
  ChatSessionInfo,
  QueuedChatMessage,
} from "../types";
import {
  isRunningTurn,
  segmentChatTimeline,
  updateChatTurnEntries,
  upsertChatTurnState,
  type ChatTimelineTurn,
} from "../lib/chatTimeline";
import { MarkdownPreview } from "./MarkdownPreview";
import { ChatActivityGroup } from "./ChatActivityGroup";
import { ChatToolCard } from "./ChatToolCard";
import { ChatAttachmentList } from "./ChatAttachments";
import { ChatApprovalCard, type ChatApprovalPrompt } from "./Shared";
import { CopyAction } from "./CopyAction";
import { SpeechPlaybackAction } from "./VoiceControls";
import { isReadableFinalResponse } from "../lib/voice";

export type ChatEntry =
  | { type: "message"; id: string; role: string; kind: string; text: string; attachments: ChatInputFile[] }
  | { type: "tool"; id: string; name: string; status: string; detail: string; output: string }
  | ({ type: "approval" } & ChatApprovalPrompt)
  | { type: "error"; id: string; text: string };

export type ChatTurn = ChatTimelineTurn<ChatEntry>;
export type ChatActivityEntry = Extract<ChatEntry, { type: "tool" }> | Extract<ChatEntry, { type: "message" }>;

export function ChatScrollControls({ targetRef, onScrollAwayFromLatest, onScrollToLatest }: {
  targetRef: RefObject<HTMLElement | null>;
  onScrollAwayFromLatest?: () => void;
  onScrollToLatest?: () => void;
}) {
  const lastScrollTopRef = useRef(0);
  const [state, setState] = useState({
    scrollable: false,
    atTop: true,
    atBottom: true,
    activeTarget: null as "top" | "bottom" | null,
  });

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return undefined;
    let frame = 0;
    let idleTimer = 0;
    const update = () => {
      frame = 0;
      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      const atTop = target.scrollTop <= 2;
      const atBottom = maxScrollTop - target.scrollTop <= 2;
      const scrollDelta = target.scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = target.scrollTop;
      if (scrollDelta > 0.5 && atBottom) onScrollToLatest?.();
      setState((current) => ({
        scrollable: maxScrollTop > 2,
        atTop,
        atBottom,
        activeTarget: scrollDelta < -0.5 ? "top" : scrollDelta > 0.5 ? "bottom" : current.activeTarget,
      }));
    };
    const scheduleUpdate = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };
    const handleScroll = () => {
      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      if (target.scrollTop < lastScrollTopRef.current - 0.5 && maxScrollTop - target.scrollTop > 2) {
        onScrollAwayFromLatest?.();
      }
      scheduleUpdate();
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = 0;
        setState((current) => current.activeTarget === null ? current : { ...current, activeTarget: null });
      }, 160);
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    const mutationObserver = new MutationObserver(scheduleUpdate);
    target.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    resizeObserver.observe(target);
    mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
    scheduleUpdate();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (idleTimer) window.clearTimeout(idleTimer);
      target.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [onScrollAwayFromLatest, onScrollToLatest, targetRef]);

  if (!state.scrollable) return null;
  const scroll = (top: number, destination: "top" | "bottom", immediate = false) => {
    const target = targetRef.current;
    if (!target) return;
    if (destination === "top") onScrollAwayFromLatest?.();
    else onScrollToLatest?.();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollTo({ top, behavior: immediate || reduceMotion ? "auto" : "smooth" });
  };
  const scrollOnPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, top: number, destination: "top" | "bottom") => {
    if (event.button !== 0) return;
    event.preventDefault();
    scroll(top, destination, true);
  };
  const scrollOnClick = (event: ReactMouseEvent<HTMLButtonElement>, top: number, destination: "top" | "bottom") => {
    if (event.detail === 0) scroll(top, destination);
  };
  return <nav className="chat-scroll-controls" aria-label="대화 위치 이동">
    <button className={state.activeTarget === "top" ? "is-active" : undefined} type="button" aria-label="대화 맨 위로 이동" title="맨 위" disabled={state.atTop} onPointerDown={(event) => scrollOnPointerDown(event, 0, "top")} onClick={(event) => scrollOnClick(event, 0, "top")}>
      <ChevronsUp size={16} strokeWidth={2.2} aria-hidden="true" />
    </button>
    <button className={state.activeTarget === "bottom" ? "is-active" : undefined} type="button" aria-label="대화 맨 아래로 이동" title="맨 아래" disabled={state.atBottom} onPointerDown={(event) => scrollOnPointerDown(event, targetRef.current?.scrollHeight ?? 0, "bottom")} onClick={(event) => scrollOnClick(event, targetRef.current?.scrollHeight ?? 0, "bottom")}>
      <ChevronsDown size={16} strokeWidth={2.2} aria-hidden="true" />
    </button>
  </nav>;
}

interface ChatEventTargets {
  activeTurnRef: MutableRefObject<string | null>;
  setTurns: Dispatch<SetStateAction<ChatTurn[]>>;
  setQueue: Dispatch<SetStateAction<QueuedChatMessage[]>>;
  onState: (session: ChatSessionInfo) => void;
  onError: (message: string | null) => void;
}

export function applyChatEvent(event: ChatEvent, targets: ChatEventTargets) {
  const { activeTurnRef, setTurns, setQueue, onState, onError } = targets;
  if (event.type === "replayReset") {
    activeTurnRef.current = null;
    setTurns([]);
    onError(null);
    return;
  }
  if (event.type === "state") {
    onState(event.session);
    return;
  }
  if (event.type === "queue") {
    setQueue(event.items);
    return;
  }
  if (event.type === "turn") {
    if (event.status === "started") {
      activeTurnRef.current = event.id;
      // 새 요청이 시작되면 세션 한도 초과 등 이전 요청의 오류 배너는 더 이상 현재 상태가 아니다.
      onError(null);
    }
    setTurns((current) => upsertChatTurnState(current, event));
    if (event.status !== "started" && activeTurnRef.current === event.id) activeTurnRef.current = null;
    return;
  }

  const turnId = activeTurnRef.current ?? "system";
  if (event.type === "messageDelta") {
    setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => upsertChatMessage(entries, event)));
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
    setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => upsertChatTool(entries, event)));
    return;
  }
  if (event.type === "approval") {
    setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => [
      ...entries.filter((entry) => entry.type !== "approval" || entry.id !== event.id),
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
    onError("다른 화면에서 이 채팅에 연결되어 이 화면의 실시간 연결이 해제되었습니다.");
    return;
  }
  if (event.type === "error") {
    onError(event.message);
    setTurns((current) => updateChatTurnEntries(current, turnId, (entries) => [
      ...entries,
      { type: "error", id: crypto.randomUUID(), text: event.message },
    ]));
  }
}

export function ChatConversationTurn({ turn, chatId, className = "", onDecision, onOpenLocalLink }: {
  turn: ChatTurn;
  chatId: string | null;
  className?: string;
  onDecision: (id: string, decision: ChatApprovalDecision) => void;
  onOpenLocalLink: (href: string) => void;
}) {
  const segments = segmentChatTimeline(turn.entries, isChatActivity, isChatEntryVisible, chatEntryKey);
  const running = isRunningTurn(turn.status);
  const lastAssistantMessage = [...turn.entries].reverse().find((entry) => entry.type === "message" && entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text));
  const lastActivityIndex = segments.reduce((latest, segment, index) => segment.type === "activity" ? index : latest, -1);
  return (
    <section className={`conversation-turn${className ? ` ${className}` : ""}`}>
      {segments.map((segment, index) => {
        if (segment.type === "entry") {
          return <ChatEntryView entry={segment.entry} chatId={chatId} copyReady={!running} speechReady={isReadableFinalResponse(turn.status, segment.entry === lastAssistantMessage)} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} key={segment.key} />;
        }
        const activities = segment.entries as ChatActivityEntry[];
        const active = running && index === segments.length - 1;
        const status = active
          ? "running"
          : !running && index === lastActivityIndex
            ? turn.status
            : completedChatActivityStatus(activities);
        return <ChatActivityGroup
          entries={activities}
          active={active}
          status={status}
          statusText={chatTurnStatusLabel(status)}
          summary={chatActivitySummary(activities)}
          meta={index === lastActivityIndex ? chatTurnDuration(turn) : undefined}
          entryKey={chatEntryKey}
          renderEntry={(entry) => <ChatEntryView entry={entry} chatId={chatId} copyReady={!running} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />}
          key={segment.key}
        />;
      })}
    </section>
  );
}

export function ChatEntryView({ entry, chatId, copyReady = true, speechReady = false, onDecision, onOpenLocalLink }: {
  entry: ChatEntry;
  chatId: string | null;
  copyReady?: boolean;
  speechReady?: boolean;
  onDecision: (id: string, decision: ChatApprovalDecision) => void;
  onOpenLocalLink?: (href: string) => void;
}) {
  if (entry.type === "message") {
    const copyable = entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text);
    const finalResponse = copyable && speechReady;
    return <article className={`chat-message chat-message-${entry.role} chat-message-${entry.kind}`}>
      <strong>{entry.kind === "reasoning" ? "진행 상황" : entry.role === "user" ? "사용자" : "에이전트"}</strong>
      {finalResponse && <SpeechPlaybackAction responseId={`${chatId ?? "chat"}:${entry.id}`} text={entry.text} />}
      {copyable && <CopyAction value={entry.text} kind="response" className="message-copy-action" disabled={!copyReady} />}
      {entry.text && <div className="chat-message-markdown"><MarkdownPreview source={entry.text} compact copyable={copyable && copyReady} onOpenLocalLink={onOpenLocalLink} /></div>}
      <ChatAttachmentList chatId={chatId} files={entry.attachments} />
    </article>;
  }
  if (entry.type === "tool") {
    return <ChatToolCard name={entry.name} status={entry.status} detail={entry.detail} output={entry.output} />;
  }
  if (entry.type === "approval") return <ChatApprovalCard prompt={entry} onDecision={onDecision} />;
  return <article className="chat-event-error">{entry.text}</article>;
}

export function activityMatches(entry: ChatEntry, filter: "all" | "tool" | "reasoning" | "error"): boolean {
  if (filter === "all") return entry.type !== "message" || entry.kind === "reasoning" || entry.role === "user";
  if (filter === "tool") return entry.type === "tool";
  if (filter === "reasoning") return entry.type === "message" && entry.kind === "reasoning";
  return entry.type === "error" || entry.type === "approval";
}

export function chatEntryKey(entry: ChatEntry): string {
  return entry.type === "message" ? `${entry.type}-${entry.id}-${entry.kind}` : `${entry.type}-${entry.id}`;
}

export function chatTurnStatusLabel(status: string): string {
  if (status === "started" || status === "running") return "응답 중";
  if (status === "completedWithDenials") return "권한 제한 후 응답 종료";
  if (status === "interrupted") return "사용자 중단";
  if (status === "failed" || status === "error") return "실패";
  return "응답 종료";
}

function upsertChatMessage(current: ChatEntry[], event: Extract<ChatEvent, { type: "messageDelta" }>): ChatEntry[] {
  const index = current.findIndex((entry) => entry.type === "message" && entry.id === event.id && entry.kind === event.kind);
  if (index < 0) {
    return [...current, { type: "message", id: event.id, role: event.role, kind: event.kind, text: event.delta, attachments: [] }];
  }
  return current.map((entry, entryIndex) => entryIndex === index && entry.type === "message"
    ? { ...entry, text: entry.text + event.delta }
    : entry);
}

function upsertChatTool(current: ChatEntry[], event: Extract<ChatEvent, { type: "tool" }>): ChatEntry[] {
  const index = current.findIndex((entry) => entry.type === "tool" && entry.id === event.id);
  if (index < 0) {
    return [...current, { type: "tool", id: event.id, name: event.name, status: event.status, detail: event.detail ?? "", output: event.output ?? "" }];
  }
  return current.map((entry, entryIndex) => entryIndex !== index || entry.type !== "tool" ? entry : {
    ...entry,
    name: event.name || entry.name,
    status: event.status,
    detail: event.append ? entry.detail + (event.detail ?? "") : (event.detail ?? entry.detail),
    output: event.append ? entry.output + (event.output ?? "") : (event.output ?? entry.output),
  });
}

function isChatActivity(entry: ChatEntry): entry is ChatActivityEntry {
  return entry.type === "tool" || (entry.type === "message" && entry.kind === "reasoning");
}

function isChatEntryVisible(entry: ChatEntry): boolean {
  return entry.type !== "approval" || !entry.interactive || Boolean(entry.resolved);
}

function completedChatActivityStatus(entries: ChatActivityEntry[]): string {
  const statuses = entries.flatMap((entry) => entry.type === "tool" ? [entry.status] : []);
  if (statuses.some((status) => status === "failed" || status === "error")) return "failed";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("completedWithDenials")) return "completedWithDenials";
  return "completed";
}

function chatActivitySummary(entries: ChatActivityEntry[]): string {
  const tools = entries.filter((entry) => entry.type === "tool").length;
  const reasoning = entries.filter((entry) => entry.type === "message" && entry.kind === "reasoning").length;
  return [tools ? `도구 ${tools}개` : "", reasoning ? `진행 상황 ${reasoning}개` : ""].filter(Boolean).join(" · ");
}

function chatTurnDuration(turn: ChatTurn): string {
  const seconds = Math.max(0, Math.round(((turn.finishedAt ?? Date.now()) - turn.startedAt) / 1000));
  return turn.finishedAt ? `${seconds}초` : "진행 중";
}
