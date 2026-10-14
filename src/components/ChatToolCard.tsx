import { memo, useRef, useState } from "react";
import { runtimeText } from "../lib/i18nRuntime";
import { boundToolCardText, formatCharCount, toolCardPreviewSource } from "../lib/toolCardText";

interface ChatToolCardProps {
  name: string;
  status: string;
  detail?: string | null;
  output?: string | null;
}

const EMPTY_JSON_LITERALS = new Set(["{}", "[]", "null"]);
const PREVIEW_KEYS = ["file_path", "path", "command", "cmd", "query"] as const;
const RUNNING_STATUSES = new Set(["running", "inProgress"]);

const TOOL_STATUS_LABELS: Record<string, string> = {
  running: "실행 중",
  inProgress: "실행 중",
  completed: "완료",
  success: "완료",
  completedWithDenials: "권한 제한",
  interrupted: "중단됨",
  failed: "실패",
  error: "실패",
  log: "로그",
};

function ChatToolSummary({ name, status, preview }: { name: string; status: string; preview: string }) {
  return <>
    <span className={`chat-tool-state chat-tool-state-${status}`} />
    <span className="chat-tool-title"><b>{name}</b>{preview && <small>{preview}</small>}</span>
    <em>{chatToolStatusLabel(status)}</em>
  </>;
}

// 트랜스크립트·채팅에서 수백 개가 그려지므로, 문자열 프로퍼티가 같으면 재조정을 건너뛴다.
export const ChatToolCard = memo(function ChatToolCard({ name, status, detail: rawDetail, output: rawOutput }: ChatToolCardProps) {
  const detail = visibleChatToolText(rawDetail ?? "");
  const output = visibleChatToolText(rawOutput ?? "");
  const preview = chatToolPreview(detail || output);
  const summary = <ChatToolSummary name={name} status={status} preview={preview} />;

  // 실행 중에 출력이 흐르기 시작한 카드(SSH 터미널처럼 줄이 이어 붙는 것)는 그 순간 펼친다.
  // 접힌 카드 뒤에서 흐르는 출력은 실시간이 아니다. 한 번 펼쳐진 뒤에는 끝나도 접지 않고,
  // 사용자가 접고 편 뒤에는 그 선택을 따른다.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const autoOpened = useRef(false);
  if (status === "running" && output) autoOpened.current = true;
  const open = userOpen ?? autoOpened.current;
  const running = RUNNING_STATUSES.has(status);

  if (!detail && !output) {
    return <div className="chat-tool chat-tool-compact"><div className="chat-tool-summary">{summary}</div></div>;
  }
  // 본문은 펼쳐져 있을 때만 세운다. 접힌 `<details>`의 자식은 그려지지 않지만 DOM 문자열로는
  // 남아, 도구 94개에 650만 자가 실린 대화를 통째로 들고 있게 된다(2026-10-05 실측).
  return <details className="chat-tool" open={open} onToggle={(event) => setUserOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && detail && <ChatToolText text={detail} running={running} />}
    {open && output && <ChatToolText text={output} running={running} className="chat-tool-output" />}
  </details>;
});

/**
 * 카드 본문 한 칸. 상한을 넘는 글은 일부만 그리고 생략 안내와 '전체 보기'를 세운다.
 *
 * 실행 중인 카드는 흐르는 쪽(뒤)을, 끝난 카드는 머리(앞)를 남긴다 — 실행 중에는 지금 무엇이
 * 나오는지가, 끝난 뒤에는 무엇을 했는지가 먼저다. 전체 보기는 사용자가 고른 한 번의 비용이라
 * 그대로 다 그린다. 왜 묶는지는 `toolCardText.ts` 머리말에 있다.
 */
function ChatToolText({ text, running, className }: { text: string; running: boolean; className?: string }) {
  const [showAll, setShowAll] = useState(false);
  const bounded = showAll ? { text, omitted: 0, total: text.length } : boundToolCardText(text, running ? "tail" : "head");
  const notice = bounded.omitted > 0 && (
    <div className="chat-tool-truncated">
      <span>{running
        ? runtimeText(`앞 ${formatCharCount(bounded.omitted)}자 생략 · 전체 ${formatCharCount(bounded.total)}자`, `${formatCharCount(bounded.omitted)} earlier characters hidden · ${formatCharCount(bounded.total)} in total`)
        : runtimeText(`뒤 ${formatCharCount(bounded.omitted)}자 생략 · 전체 ${formatCharCount(bounded.total)}자`, `${formatCharCount(bounded.omitted)} later characters hidden · ${formatCharCount(bounded.total)} in total`)}</span>
      <button className="button compact" type="button" onClick={() => setShowAll(true)}>{runtimeText("전체 보기", "Full view")}</button>
    </div>
  );
  return <>
    {running && notice}
    <pre className={className}>{bounded.text}</pre>
    {!running && notice}
  </>;
}

function visibleChatToolText(text: string): string {
  const trimmed = text.trim();
  return EMPTY_JSON_LITERALS.has(trimmed) ? "" : trimmed;
}

function chatToolPreview(text: string): string {
  if (!text) return "";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      const preview = value[key];
      if (typeof preview === "string") return preview;
    }
  } catch {
    // 일반 텍스트 요약으로 넘어간다.
  }
  return toolCardPreviewSource(text).replace(/\s+/g, " ").slice(0, 76);
}

function chatToolStatusLabel(status: string): string {
  return TOOL_STATUS_LABELS[status] ?? status;
}
