import { memo, useRef, useState } from "react";

interface ChatToolCardProps {
  name: string;
  status: string;
  detail?: string | null;
  output?: string | null;
}

const EMPTY_JSON_LITERALS = new Set(["{}", "[]", "null"]);
const PREVIEW_KEYS = ["file_path", "path", "command", "cmd", "query"] as const;

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

  if (!detail && !output) {
    return <div className="chat-tool chat-tool-compact"><div className="chat-tool-summary">{summary}</div></div>;
  }
  return <details className="chat-tool" open={open} onToggle={(event) => setUserOpen(event.currentTarget.open)}><summary>{summary}</summary>{detail && <pre>{detail}</pre>}{output && <pre className="chat-tool-output">{output}</pre>}</details>;
});

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
  return text.replace(/\s+/g, " ").slice(0, 76);
}

function chatToolStatusLabel(status: string): string {
  return TOOL_STATUS_LABELS[status] ?? status;
}
