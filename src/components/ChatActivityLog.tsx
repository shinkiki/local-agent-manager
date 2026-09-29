import type { ReactNode, RefObject } from "react";
import { formatDate } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { runtimeText } from "../lib/i18nRuntime";
import { activityMatches, type ActivityFilter } from "../lib/activityFilter";
import { EmptyState } from "./Shared";
import { ActivityFilterSelect } from "./SessionTranscript";
import {
  ChatEntryView,
  chatTurnStatusLabel,
  type ChatEntry,
  type ChatEntryActions,
  type ChatTurn,
} from "./ChatConversation";

export interface ChatActivityLogProps extends ChatEntryActions {
  containerRef: RefObject<HTMLDivElement | null>;
  history: ReactNode;
  turns: ChatTurn[];
  chatId: string | null;
  filter: ActivityFilter;
  onFilter: (filter: ActivityFilter) => void;
}

/**
 * 사용자 턴의 제목을 뽑는다. 사용자 메시지가 있으면 첫 80자, 없으면 첫 첨부 파일 이름,
 * 둘 다 없으면 기본 문구로 떨어진다.
 */
function chatTurnTitle(turn: ChatTurn): string {
  const userEntry = turn.entries.find(
    (entry): entry is Extract<ChatEntry, { type: "message" }> => entry.type === "message" && entry.role === "user",
  );
  return userEntry?.text.slice(0, 80) || userEntry?.attachments[0]?.name || runtimeText("시스템 작업", "System activity");
}

/** 실시간 채팅의 작업 로그 턴 한 칸. */
function ChatActivityTurnItem({
  turn,
  entries,
  chatId,
  onDecision,
  onOpenLocalLink,
}: {
  turn: ChatTurn;
  entries: ChatEntry[];
  chatId: string | null;
} & ChatEntryActions) {
  const title = chatTurnTitle(turn);
  return (
    <section className="activity-turn" key={turn.id}>
      <header>
        <span className={`chat-tool-state chat-tool-state-${turn.status}`} />
        <strong>{title}</strong>
        <time>{chatTurnStatusLabel(turn.status)} · {formatDate(turn.startedAt)}</time>
      </header>
      <div>
        {entries.map((entry) => (
          <ChatEntryView
            entry={entry}
            chatId={chatId}
            onDecision={onDecision}
            onOpenLocalLink={onOpenLocalLink}
            key={`${entry.type}-${entry.id}`}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * 채팅 화면의 작업 로그 탭 본문.
 *
 * 이전 연결 내역(history)과 현재 연결의 턴별 활동(추론·도구 호출 등)을 필터에 맞춰
 * 세운다. 대화 탭과 달리 요청(사용자 턴) 단위로 묶인 작업 내역을 펼쳐 보여 주며,
 * 대화 화면 본체(ChatView)에 섞여 있던 탭 전용 마크업을 여기로 가른다.
 */
export function ChatActivityLog({
  containerRef,
  history,
  turns,
  chatId,
  filter,
  onFilter,
  onDecision,
  onOpenLocalLink,
}: ChatActivityLogProps) {
  const { text } = useI18n();
  return (
    <div className="activity-log" ref={containerRef}>
      <header>
        <strong>{text("요청별 작업 로그", "Activity log per request")}</strong>
        <ActivityFilterSelect value={filter} onChange={onFilter} />
      </header>
      {history}
      {turns.length === 0 ? (
        history ? null : <EmptyState title={text("작업 로그가 없습니다", "No activity logs")} />
      ) : (
        turns.map((turn) => {
          const entries = turn.entries.filter((entry) => activityMatches(entry, filter));
          if (entries.length === 0) return null;
          return (
            <ChatActivityTurnItem
              key={turn.id}
              turn={turn}
              entries={entries}
              chatId={chatId}
              onDecision={onDecision}
              onOpenLocalLink={onOpenLocalLink}
            />
          );
        })
      )}
    </div>
  );
}
