import { formatDate } from "../lib/format";
import { useI18n } from "../lib/i18n";

/** One user-message heading for saved sessions, live chats and AIA. */
export function UserMessageHeader({ timestamp, live = false }: {
  timestamp: number | null;
  live?: boolean;
}) {
  const { text } = useI18n();
  const date = timestamp == null ? null : new Date(timestamp);
  const validDate = date && Number.isFinite(date.getTime()) ? date : null;
  return <header className="user-message-header">
    <strong>{text("사용자 요청", "User request")}</strong>
    {validDate && <time dateTime={validDate.toISOString()} title={live ? text("대화 턴 시작 시각", "Conversation turn start time") : undefined}>{formatDate(timestamp)}</time>}
  </header>;
}
