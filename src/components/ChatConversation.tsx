import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import type { ChatApprovalDecision } from "../types";
import {
  isRunningTurn,
  segmentChatTimeline,
  type ChatTimelineSegment,
} from "../lib/chatTimeline";
import { splitAgentMessageMeta } from "../lib/agentMessageMeta";
import { collectChatSkillUsages, isSkillUsageEntry } from "../lib/skillUsage";
import { MarkdownPreview } from "./MarkdownPreview";
import { AgentMessageMetaList } from "./AgentMessageMeta";
import { ChatActivityGroup } from "./ChatActivityGroup";
import { ChatSkillUsageCard } from "./ChatSkillUsage";
import { ChatToolCard } from "./ChatToolCard";
import { ChatAttachmentList } from "./ChatAttachments";
import { ChatApprovalCard } from "./Shared";
import type { ChatActivityEntry, ChatEntry, ChatTurn } from "./ChatEventStream";
import { CopyAction } from "./CopyAction";
import { SpeechPlaybackAction } from "./VoiceControls";
import { isReadableFinalResponse } from "../lib/voice";
import { liveMessageKey } from "../lib/readingAnchor";
import { useI18n } from "../lib/i18n";

// 이 모듈은 대화를 그리는 쪽의 정문이다. 상태 모델과 이벤트 접기는 `ChatEventStream`이
// 맡지만, 그리기와 함께 쓰이는 이름이라 여기서도 그대로 꺼내 준다.
export type { ChatEntry, ChatTurn, ChatActivityEntry } from "./ChatEventStream";
export { applyChatEvent } from "./ChatEventStream";

/**
 * 대화 항목을 그리는 쪽이 위에서 받아 아래로 그대로 넘기는 두 손잡이. 승인 결정과 본문 속
 * 로컬 링크 열기는 어느 화면에서 그리든 같은 모양이라, 대화 화면·활동 기록·AIA 팝업의 여덟
 * 자리가 각자 같은 인라인 타입을 적고 있었다. 한쪽만 고치면 타입이 조용히 갈라지므로 이름
 * 하나로 모은다.
 */
export interface ChatEntryActions {
  onDecision: (id: string, decision: ChatApprovalDecision) => void;
  onOpenLocalLink: (href: string) => void;
}

/** 사용자 결정을 기다리는 미해결 승인만 대화 전체에서 모은다. */
export function pendingChatApprovals(turns: ChatTurn[]): Extract<ChatEntry, { type: "approval" }>[] {
  return turns
    .flatMap((turn) => turn.entries)
    .filter((entry): entry is Extract<ChatEntry, { type: "approval" }> => (
      entry.type === "approval" && entry.interactive && !entry.resolved
    ));
}

/**
 * 새 응답이 흘러들어올 때 화면을 맨 아래에 붙여 두는 손잡이. 사용자가 위로 올려 읽기
 * 시작하면 따라가기를 멈추고, 다시 맨 아래로 돌아오면 재개한다 —
 * `ChatScrollControls`의 두 콜백이 그 두 자리다.
 *
 * 대화 화면과 AIA 팝업이 같은 규칙을 두 벌로 들고 있었다. 한쪽만 고치면 한 화면에서만
 * 응답이 따라 내려가는 식으로 조용히 갈라지므로, 되돌리기·따라붙기·멈춤/재개를 여기
 * 한 벌로 모은다. 어디까지가 "따라갈 자리"인지(탭·팝업 열림)와 기본값은 그대로 각
 * 화면이 정한다.
 */
export function useFollowLatestMessages({ targetRef, enabled, follow, resetKey, growth }: {
  targetRef: RefObject<HTMLElement | null>;
  /** 지금 이 화면이 최신을 따라갈 자리인가(대화 탭이 떠 있는가, 팝업이 열려 있는가). */
  enabled: boolean;
  /** 따라가기의 기본값. 표시 설정이 '최신부터'가 아니면 맨 아래로 돌아와도 따라가지 않는다. */
  follow: boolean;
  /** 이 값이 바뀌면(대화 전환 등) 따라가기를 기본값으로 되돌린다. */
  resetKey: string | null;
  /** 이 값이 바뀔 때마다 맨 아래로 붙인다. 대개 턴 목록이다. */
  growth: unknown;
}) {
  const followingRef = useRef(follow);

  useEffect(() => {
    followingRef.current = follow;
  }, [resetKey, follow]);

  useEffect(() => {
    if (!enabled || !followingRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (!followingRef.current) return;
      const target = targetRef.current;
      if (target) target.scrollTo({ top: target.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, growth, targetRef]);

  const pause = useCallback(() => {
    followingRef.current = false;
  }, []);
  const resume = useCallback(() => {
    followingRef.current = follow;
  }, [follow]);

  return { followingRef, pause, resume };
}

export function ChatScrollControls({ targetRef, leading, onScrollAwayFromLatest, onScrollToLatest }: {
  targetRef: RefObject<HTMLElement | null>;
  /**
   * 맨 위 버튼보다 위에 함께 세우는 것(읽던 자리 버튼 묶음). 같은 열에 서야 하므로
   * 옆에 따로 띄우지 않고 이 묶음이 직접 그린다 — 두 벌로 두면 스크롤 버튼이 사라지는
   * 대화(스크롤이 필요 없는 짧은 대화)에서 옆엣것만 허공에 남는다.
   *
   * 스크롤이 가능한지를 인자로 받는다. 그 판정을 이미 여기서 하고 있어, 받는 쪽이
   * 같은 관찰자를 한 벌 더 붙이지 않아도 된다.
   */
  leading?: (scrollable: boolean) => ReactNode;
  onScrollAwayFromLatest?: () => void;
  onScrollToLatest?: () => void;
}) {
  const { text } = useI18n();
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

  const leadingContent = leading?.(state.scrollable) ?? null;
  // 스크롤할 것도 없고 위에 세울 것도 없으면 아무것도 그리지 않는다.
  if (!state.scrollable && !leadingContent) return null;
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
  const scrollActions = [
    {
      target: "top" as const,
      label: text("대화 맨 위로 이동", "Go to the top of the conversation"),
      title: text("맨 위", "Top"),
      disabled: state.atTop,
      top: 0,
      icon: ChevronsUp,
    },
    {
      target: "bottom" as const,
      label: text("대화 맨 아래로 이동", "Go to the bottom of the conversation"),
      title: text("맨 아래", "Bottom"),
      disabled: state.atBottom,
      top: targetRef.current?.scrollHeight ?? 0,
      icon: ChevronsDown,
    },
  ];
  return <nav className="chat-scroll-controls" aria-label={text("대화 위치 이동", "Move within the conversation")}>
    {leadingContent}
    {state.scrollable && scrollActions.map(({ target, label, title, disabled, top, icon: Icon }) => (
      <button
        key={target}
        className={state.activeTarget === target ? "is-active" : undefined}
        type="button"
        aria-label={label}
        title={title}
        disabled={disabled}
        onPointerDown={(event) => scrollOnPointerDown(event, top, target)}
        onClick={(event) => scrollOnClick(event, top, target)}
      >
        <Icon size={16} strokeWidth={2.2} aria-hidden="true" />
      </button>
    ))}
  </nav>;
}

/** 마지막 사용자 메시지를 식별하는 키. 새 메시지를 보내면 값이 바뀐다. */
export function lastUserMessageKey(turns: ChatTurn[]): string | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const entries = turns[turnIndex].entries;
    for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
      const entry = entries[entryIndex];
      if (entry.type === "message" && entry.role === "user" && entry.kind === "message") {
        return `${turns[turnIndex].id}:${entry.id}`;
      }
    }
  }
  return null;
}

/**
 * 컨테이너 안에서 마지막 사용자 메시지가 화면 맨 위에 오도록 스크롤한다.
 * 라이브 채팅(.chat-message-user)과 세션 트랜스크립트(.message-user)를 함께 다룬다.
 */
export function scrollToLastUserMessage(container: HTMLElement | null): boolean {
  if (!container) return false;
  const messages = container.querySelectorAll<HTMLElement>(".chat-message-user, .message-user");
  const target = messages[messages.length - 1];
  if (!target) return false;
  const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  container.scrollTo({ top: Math.max(0, top - 12), behavior: "auto" });
  return true;
}

/** 활동 구간 머리줄에 적을 값들. 무엇을 적을지는 화면마다 다르므로 `describe`가 정한다. */
interface ChatActivityDescription {
  status: string;
  statusText: string;
  summary: string;
  meta?: string;
}

/**
 * 턴 안의 도구 실행·추론 활동 구간 하나를 세운다.
 *
 * 스킬 실행은 작업 로그에서 빼내 대화 흐름에 사용 스킬 카드로 세운다. 로그 안의
 * 도구 호출 하나로 남으면 무엇이 걸렸는지 펼치기 전까지 보이지 않는다.
 *
 * 일반 대화와 AIA 팝업이 이 뼈대를 똑같이 쓰고 머리줄 문구와 낱개 항목만 갈라진다.
 * 두 벌로 적어 두면 한쪽에서만 스킬 카드를 빼내는 식으로 조용히 어긋난다.
 */
function ChatActivitySegment({ entries, active, describe, renderEntry }: {
  entries: ChatActivityEntry[];
  active: boolean;
  describe: (logged: ChatActivityEntry[]) => ChatActivityDescription;
  renderEntry: (entry: ChatActivityEntry) => ReactNode;
}) {
  const skillUsages = collectChatSkillUsages(entries);
  const logged = entries.filter((entry) => !isSkillUsageEntry(entry));
  const description = logged.length > 0 ? describe(logged) : null;
  return (
    <>
      <ChatSkillUsageCard usages={skillUsages} />
      {description && <ChatActivityGroup
        entries={logged}
        active={active}
        status={description.status}
        statusText={description.statusText}
        summary={description.summary}
        meta={description.meta}
        entryKey={chatEntryKey}
        renderEntry={renderEntry}
      />}
    </>
  );
}

/** 턴 하나를 그리기 전에 정해 두는 조각들. `chatTurnLayout`이 한 벌로 만든다. */
interface ChatTurnLayout {
  /** 활동 구간과 낱개 항목으로 나뉜 타임라인. */
  segments: ChatTimelineSegment<ChatEntry>[];
  running: boolean;
  /** 읽어주기·이어쓰기를 붙일 마지막 에이전트 응답. 없으면 undefined. */
  lastAssistantMessage: ChatEntry | undefined;
  /** 진행 시간을 붙일 마지막 활동 구간의 위치. 활동이 없으면 -1. */
  lastActivityIndex: number;
}

/**
 * 일반 대화와 AIA 팝업은 턴을 같은 규칙으로 나눠 그린다. 네 줄을 두 벌로 적어 두면
 * 한쪽만 고쳤을 때 마지막 응답 판정이나 활동 구간 위치가 조용히 갈라진다 — 읽어주기
 * 버튼이 한 화면에만 붙는 식으로. 나누는 규칙만 여기 모으고, 무엇을 세울지는 그대로
 * 각 화면이 정한다.
 */
function chatTurnLayout(turn: ChatTurn): ChatTurnLayout {
  const segments = segmentChatTimeline(turn.entries, isChatActivity, isChatEntryVisible, chatEntryKey);
  return {
    segments,
    running: isRunningTurn(turn.status),
    lastAssistantMessage: [...turn.entries].reverse().find((entry) => entry.type === "message" && entry.role === "assistant" && entry.kind === "message" && Boolean(entry.text)),
    lastActivityIndex: segments.reduce((latest, segment, index) => segment.type === "activity" ? index : latest, -1),
  };
}

/** 항목 하나를 세울 때 턴 전체를 봐야 정해지는 값들. 두 화면이 같은 판정을 쓴다. */
interface ChatEntrySegmentContext {
  /** 복사·읽어주기를 눌러도 되는 상태. 스트리밍 중에는 본문이 계속 자란다. */
  copyReady: boolean;
  /** 턴이 끝났고 이 항목이 그 턴의 마지막 에이전트 응답인가. */
  completedFinal: boolean;
  /** 읽어주기를 붙일 수 있는 항목인가. */
  speechReady: boolean;
}

/** 활동 구간 하나를 세울 때 턴 전체를 봐야 정해지는 값들. */
interface ChatActivitySegmentContext {
  /** 지금 자라고 있는 구간(턴의 마지막 구간)인가. */
  active: boolean;
  /** 턴에서 가장 뒤에 있는 활동 구간인가. */
  isLastActivity: boolean;
  running: boolean;
}

/**
 * 턴 하나를 세그먼트로 훑어 그리는 껍데기. 나누는 규칙은 `chatTurnLayout`이 한 벌로
 * 모았지만, 그것을 훑으며 "마지막 응답인가·지금 도는 구간인가"를 정하는 대여섯 줄은
 * 일반 대화와 AIA 팝업에 두 벌로 남아 있었다 — 한쪽만 고치면 읽어주기 버튼이 한
 * 화면에만 붙는 식으로 조용히 갈라진다. 훑기와 판정만 여기 모으고, 무엇을 세울지는
 * 그대로 각 화면이 콜백으로 정한다.
 *
 * 활동 구간의 뼈대도 여기서 세운다. 두 화면이 각자 여덟 개 손잡이를 그대로 넘겨 주는
 * 전용 감싸개를 한 벌씩 두고 있었는데, 갈라지는 것은 머리줄을 짓는 규칙과 낱개 항목을
 * 세우는 방법 둘뿐이라 그 둘만 콜백으로 받는다.
 */
export function ChatTurnSegments({ turn, className, renderEntry, describeActivity, renderActivityEntry }: {
  turn: ChatTurn;
  className: string;
  renderEntry: (entry: ChatEntry, context: ChatEntrySegmentContext) => ReactNode;
  /** 활동 구간 머리줄. 스킬 카드로 빠진 항목을 뺀 `logged`만 받는다. */
  describeActivity: (logged: ChatActivityEntry[], context: ChatActivitySegmentContext) => ChatActivityDescription;
  renderActivityEntry: (entry: ChatActivityEntry, context: ChatActivitySegmentContext) => ReactNode;
}) {
  const { segments, running, lastAssistantMessage, lastActivityIndex } = chatTurnLayout(turn);
  return (
    <section className={className}>
      {segments.map((segment, index) => {
        if (segment.type === "entry") {
          const finalAssistantMessage = segment.entry === lastAssistantMessage;
          return <Fragment key={segment.key}>{renderEntry(segment.entry, {
            copyReady: !running,
            completedFinal: !running && finalAssistantMessage,
            // 읽어주기는 완료된 턴에서만 붙으므로 running을 따로 빼지 않아도 같은 값이다.
            speechReady: isReadableFinalResponse(turn.status, finalAssistantMessage),
          })}</Fragment>;
        }
        const context: ChatActivitySegmentContext = {
          active: running && index === segments.length - 1,
          isLastActivity: index === lastActivityIndex,
          running,
        };
        return <Fragment key={segment.key}><ChatActivitySegment
          entries={segment.entries as ChatActivityEntry[]}
          active={context.active}
          describe={(logged) => describeActivity(logged, context)}
          renderEntry={(entry) => renderActivityEntry(entry, context)}
        /></Fragment>;
      })}
    </section>
  );
}

export function ChatConversationTurn({ turn, chatId, className = "", onDecision, onOpenLocalLink }: {
  turn: ChatTurn;
  chatId: string | null;
  className?: string;
} & ChatEntryActions) {
  return (
    <ChatTurnSegments
      turn={turn}
      className={`conversation-turn${className ? ` ${className}` : ""}`}
      renderEntry={(entry, { copyReady, speechReady }) =>
        <ChatEntryView entry={entry} chatId={chatId} copyReady={copyReady} speechReady={speechReady} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />}
      // 머리줄은 턴 상태 사다리를 따르고 마지막 구간에만 진행 시간을 붙인다.
      describeActivity={(logged, { active, isLastActivity, running }) => {
        const status = active
          ? "running"
          : !running && isLastActivity
            ? turn.status
            : completedChatActivityStatus(logged);
        return {
          status,
          statusText: chatTurnStatusLabel(status),
          summary: chatActivitySummary(logged),
          meta: isLastActivity ? chatTurnDuration(turn) : undefined,
        };
      }}
      renderActivityEntry={(entry, { running }) =>
        <ChatEntryView entry={entry} chatId={chatId} copyReady={!running} onDecision={onDecision} onOpenLocalLink={onOpenLocalLink} />}
    />
  );
}

/** 메시지 역할 및 성격에 따른 표시 라벨 */
function messageRoleLabel(role: string, kind: string): string {
  if (kind === "reasoning") return "진행 상황";
  // 앱이 직접 적은 알림은 에이전트가 한 말이 아니다. 답 없이 끝난 턴을 알리는 자리가
  // 그것인데, 같은 라벨을 달면 모델이 그렇게 말한 것으로 읽힌다.
  if (role === "system") return "시스템";
  return role === "user" ? "사용자" : "에이전트";
}

/**
 * 대화 메시지 한 칸의 껍데기. 일반 대화와 AIA 팝업이 각자 같은 다섯 줄을 적고 있었다 —
 * 역할 클래스가 붙은 `article`, 이름표, 읽어주기·복사 단추의 등장 조건, 본문 마크다운,
 * 첨부 목록. 갈라지는 것은 이름표 문구, 읽어주기 식별자 앞머리, 메타 블록을 붙일지,
 * 응답에서 프롬프트를 꽂을 수 있는지뿐이라 그 넷만 손잡이로 받는다.
 *
 * `text`는 화면에 보일 본문이다. 복사·읽어주기·마크다운이 모두 이 값을 쓰므로, 메타
 * 블록을 걷어내는 쪽은 걷어낸 본문을 넘긴다.
 */
export function ChatMessageArticle({
  entry,
  chatId,
  copyReady,
  speechReady,
  text,
  label,
  speechIdPrefix = "",
  messageKey,
  meta,
  onOpenLocalLink,
  onInsertPrompt,
}: {
  entry: Extract<ChatEntry, { type: "message" }>;
  chatId: string | null;
  copyReady: boolean;
  speechReady: boolean;
  text: string;
  label: string;
  speechIdPrefix?: string;
  messageKey?: string;
  meta?: ReactNode;
  onInsertPrompt?: (prompt: string) => void;
} & Pick<ChatEntryActions, "onOpenLocalLink">) {
  const copyable = entry.role === "assistant" && entry.kind === "message" && Boolean(text);
  return (
    <article
      className={`chat-message chat-message-${entry.role} chat-message-${entry.kind}`}
      data-message-key={messageKey}
    >
      <strong>{label}</strong>
      {copyable && speechReady && <SpeechPlaybackAction responseId={`${speechIdPrefix}${chatId ?? "chat"}:${entry.id}`} text={text} />}
      {copyable && <CopyAction value={text} kind="response" className="message-copy-action" disabled={!copyReady} />}
      {text && <div className="chat-message-markdown"><MarkdownPreview source={text} compact copyable={copyable && copyReady} onOpenLocalLink={onOpenLocalLink} onInsertPrompt={entry.role === "assistant" ? onInsertPrompt : undefined} /></div>}
      {meta}
      <ChatAttachmentList chatId={chatId} files={entry.attachments} />
    </article>
  );
}

/** 사용자 및 에이전트 대화 메시지 단건 뷰 */
function ChatMessageEntryView({
  entry,
  chatId,
  copyReady,
  speechReady,
  onOpenLocalLink,
}: {
  entry: Extract<ChatEntry, { type: "message" }>;
  chatId: string | null;
  copyReady: boolean;
  speechReady: boolean;
} & Pick<ChatEntryActions, "onOpenLocalLink">) {
  // 공급자가 붙인 메타 블록은 본문이 아니다. 복사와 읽어주기도 걷어낸 본문만 쓴다.
  const { text, meta } = splitAgentMessageMeta(entry.text);
  return (
    <ChatMessageArticle
      entry={entry}
      chatId={chatId}
      copyReady={copyReady}
      speechReady={speechReady}
      text={text}
      label={messageRoleLabel(entry.role, entry.kind)}
      messageKey={liveMessageKey(entry.id, entry.kind)}
      meta={<AgentMessageMetaList meta={meta} />}
      onOpenLocalLink={onOpenLocalLink}
    />
  );
}

export function ChatEntryView({ entry, chatId, copyReady = true, speechReady = false, onDecision, onOpenLocalLink }: {
  entry: ChatEntry;
  chatId: string | null;
  copyReady?: boolean;
  speechReady?: boolean;
} & ChatEntryActions) {
  if (entry.type === "message") {
    return <ChatMessageEntryView entry={entry} chatId={chatId} copyReady={copyReady} speechReady={speechReady} onOpenLocalLink={onOpenLocalLink} />;
  }
  if (entry.type === "tool") {
    return <ChatToolCard name={entry.name} status={entry.status} detail={entry.detail} output={entry.output} />;
  }
  if (entry.type === "approval") return <ChatApprovalCard prompt={entry} onDecision={onDecision} />;
  return <article className="chat-event-error">{entry.text}</article>;
}

export function chatEntryKey(entry: ChatEntry): string {
  return entry.type === "message" ? `${entry.type}-${entry.id}-${entry.kind}` : `${entry.type}-${entry.id}`;
}

const TURN_STATUS_LABELS: Record<string, string> = {
  started: "응답 중",
  running: "응답 중",
  completedWithDenials: "권한 제한 후 응답 종료",
  interrupted: "사용자 중단",
  failed: "실패",
  error: "실패",
};

export function chatTurnStatusLabel(status: string): string {
  return TURN_STATUS_LABELS[status] ?? "응답 종료";
}

export function chatActivityCounts(entries: ChatActivityEntry[]): { tools: number; reasoning: number } {
  let tools = 0;
  let reasoning = 0;
  for (const entry of entries) {
    if (entry.type === "tool") tools += 1;
    if (entry.type === "message" && entry.kind === "reasoning") reasoning += 1;
  }
  return { tools, reasoning };
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
  const { tools, reasoning } = chatActivityCounts(entries);
  return [tools ? `도구 ${tools}개` : "", reasoning ? `진행 상황 ${reasoning}개` : ""].filter(Boolean).join(" · ");
}

function chatTurnDuration(turn: ChatTurn): string {
  const seconds = Math.max(0, Math.round(((turn.finishedAt ?? Date.now()) - turn.startedAt) / 1000));
  return turn.finishedAt ? `${seconds}초` : "진행 중";
}
