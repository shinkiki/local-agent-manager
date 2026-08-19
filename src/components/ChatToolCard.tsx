import { memo } from "react";

interface ChatToolCardProps {
  name: string;
  status: string;
  detail?: string | null;
  output?: string | null;
}

// 트랜스크립트·채팅에서 수백 개가 그려지므로, 문자열 프로퍼티가 같으면 재조정을 건너뛴다.
export const ChatToolCard = memo(function ChatToolCard({ name, status, detail: rawDetail, output: rawOutput }: ChatToolCardProps) {
  const detail = visibleChatToolText(rawDetail ?? "");
  const output = visibleChatToolText(rawOutput ?? "");
  const preview = chatToolPreview(detail || output);
  if (!detail && !output) {
    return <div className="chat-tool chat-tool-compact"><div className="chat-tool-summary"><span className={`chat-tool-state chat-tool-state-${status}`} /><span className="chat-tool-title"><b>{name}</b>{preview && <small>{preview}</small>}</span><em>{chatToolStatusLabel(status)}</em></div></div>;
  }
  return <details className="chat-tool"><summary><span className={`chat-tool-state chat-tool-state-${status}`} /><span className="chat-tool-title"><b>{name}</b>{preview && <small>{preview}</small>}</span><em>{chatToolStatusLabel(status)}</em></summary>{detail && <pre>{detail}</pre>}{output && <pre className="chat-tool-output">{output}</pre>}</details>;
});

function visibleChatToolText(text: string): string {
  const trimmed = text.trim();
  return trimmed === "{}" || trimmed === "[]" || trimmed === "null" ? "" : trimmed;
}

function chatToolPreview(text: string): string {
  if (!text) return "";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const preview = value.file_path ?? value.path ?? value.command ?? value.cmd ?? value.query;
    if (typeof preview === "string") return preview;
  } catch {
    // Plain text is summarized below.
  }
  return text.replace(/\s+/g, " ").slice(0, 76);
}

function chatToolStatusLabel(status: string): string {
  if (status === "running" || status === "inProgress") return "실행 중";
  if (status === "completed" || status === "success") return "완료";
  if (status === "completedWithDenials") return "권한 제한";
  if (status === "interrupted") return "중단됨";
  if (status === "failed" || status === "error") return "실패";
  return status === "log" ? "로그" : status;
}
