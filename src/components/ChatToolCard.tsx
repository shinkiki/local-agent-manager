import { memo, useMemo, useState } from "react";
import { runtimeText } from "../lib/i18nRuntime";
import { fileEditRows, parseToolCardJson, toolCardDiffStats, toolCardEditPreview, toolCardFileEdits, type ToolCardDiffRow, type ToolCardFileEdit } from "../lib/toolCardDiff";
import { boundToolCardText, formatCharCount, MAX_TOOL_CARD_DIFF_ROWS, toolCardPreviewSource } from "../lib/toolCardText";

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
  // 파일을 고친 카드는 인자 원문 대신 파일별 diff를 그린다. 원문은 '원문' 버튼으로 본다.
  // 푼 JSON은 붙들지 않는다 — 큰 Write 인자가 원문과 함께 두 벌로 남는다.
  const { edits, preview } = useMemo(() => {
    const parsed = parseToolCardJson(detail);
    const fileEdits = toolCardFileEdits(name, parsed);
    return {
      edits: fileEdits,
      preview: fileEdits ? toolCardEditPreview(fileEdits) : chatToolPreview(detail || output, detail ? parsed : parseToolCardJson(output)),
    };
  }, [name, detail, output]);
  const [showRaw, setShowRaw] = useState(false);
  const summary = <ChatToolSummary name={name} status={status} preview={preview} />;

  // 출력 도착이나 완료 상태 변경은 사용자의 펼침 선택을 바꾸지 않는다.
  const [open, setOpen] = useState(false);
  const running = RUNNING_STATUSES.has(status);

  if (!detail && !output) {
    return <div className="chat-tool chat-tool-compact"><div className="chat-tool-summary">{summary}</div></div>;
  }
  // 본문은 펼쳐져 있을 때만 세운다. 접힌 `<details>`의 자식은 그려지지 않지만 DOM 문자열로는
  // 남아, 도구 94개에 650만 자가 실린 대화를 통째로 들고 있게 된다(2026-10-05 실측).
  return <details className="chat-tool" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && detail && (edits
      ? <ChatToolEdits edits={edits} raw={showRaw ? detail : null} running={running} onToggleRaw={() => setShowRaw((current) => !current)} />
      : <ChatToolText text={detail} running={running} />)}
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

/**
 * 파일 변경 카드의 본문. 파일마다 경로·종류·증감 머리줄과 diff를 그린다.
 *
 * 행 수 상한은 `ChatToolText`의 글자 상한과 같은 이유다(`toolCardText.ts` 머리말) — 파일
 * 전체를 쓴 `Write` 하나가 수천 줄일 수 있다. 상한은 카드 전체에 걸고, 넘으면 남은 파일은
 * 머리줄만 그린 채 '전체 보기'를 세운다.
 */
function ChatToolEdits({ edits, raw, running, onToggleRaw }: {
  edits: ToolCardFileEdit[];
  raw: string | null;
  running: boolean;
  onToggleRaw: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const files = useMemo(() => edits.map((edit) => {
    const rows = fileEditRows(edit);
    return { edit, rows, stats: toolCardDiffStats(rows) };
  }), [edits]);
  let budget = showAll ? Number.POSITIVE_INFINITY : MAX_TOOL_CARD_DIFF_ROWS;
  let hidden = 0;
  const shown = files.map((file) => {
    const visible = file.rows.slice(0, Math.max(0, budget));
    budget -= visible.length;
    hidden += file.rows.length - visible.length;
    return { ...file, visible };
  });
  return <div className="chat-tool-edits">
    <div className="chat-tool-edits-bar">
      <span>{runtimeText(`파일 ${edits.length}개`, `${edits.length} file(s)`)}</span>
      <button className="button compact" type="button" aria-pressed={raw !== null} onClick={onToggleRaw}>
        {raw !== null ? runtimeText("diff 보기", "Show diff") : runtimeText("원문", "Raw")}
      </button>
    </div>
    {raw !== null
      ? <ChatToolText text={raw} running={running} />
      : shown.map(({ edit, rows, visible, stats }, index) => (
        <section className="chat-tool-edit" key={`${edit.path}-${index}`}>
          <header>
            <code title={edit.path}>{edit.path}{edit.kind === "patch" && edit.movePath ? ` → ${edit.movePath}` : ""}</code>
            <small>{fileEditLabel(edit)}</small>
            {stats.added > 0 && <span className="skill-diff-count added">+{stats.added}</span>}
            {stats.removed > 0 && <span className="skill-diff-count removed">-{stats.removed}</span>}
          </header>
          {rows.length === 0
            ? <p className="skill-diff-note">{runtimeText("바뀐 내용이 없습니다.", "No changes.")}</p>
            : visible.length > 0 && <ChatToolDiffRows rows={visible} lineNumbers={edit.kind !== "replace"} />}
        </section>
      ))}
    {raw === null && hidden > 0 && (
      <div className="chat-tool-truncated">
        <span>{runtimeText(`${hidden.toLocaleString()}줄 더 있음`, `${hidden.toLocaleString()} more line(s)`)}</span>
        <button className="button compact" type="button" onClick={() => setShowAll(true)}>{runtimeText("전체 보기", "Full view")}</button>
      </div>
    )}
  </div>;
}

/** 바꾸기 조각은 파일 안 위치를 모르므로 줄 번호 칸 없이 그린다. */
function ChatToolDiffRows({ rows, lineNumbers }: { rows: ToolCardDiffRow[]; lineNumbers: boolean }) {
  return <pre className={`skill-diff chat-tool-diff${lineNumbers ? "" : " no-line-numbers"}`} data-user-content>
    {rows.map((row, index) => {
      if (row.kind === "skip") {
        return <div className="skip" key={index}>{runtimeText(`… ${row.count}줄 동일`, `… ${row.count} unchanged line(s)`)}</div>;
      }
      if (row.kind === "editBoundary") {
        const label = row.total > 1 ? runtimeText(`편집 ${row.index}/${row.total}`, `Edit ${row.index}/${row.total}`) : "";
        const all = row.replaceAll ? runtimeText("모두 바꾸기", "Replace all") : "";
        return <div className="skip" key={index}>{[label, all].filter(Boolean).join(" · ")}</div>;
      }
      if (row.kind === "hunk") return <div className="skip" key={index}>{row.text}</div>;
      if (row.kind === "meta") return <div className="meta" key={index}>{row.text}</div>;
      if (row.kind === "noNewline") return <div className="meta" key={index}>{runtimeText("\\ 파일 끝에 개행 없음", "\\ No newline at end of file")}</div>;
      return <div className={row.kind} key={index}>
        {lineNumbers && <span className="ln">{row.before ?? ""}</span>}
        {lineNumbers && <span className="ln">{row.after ?? ""}</span>}
        <span className="sign">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
        <span className="txt">{row.text}</span>
      </div>;
    })}
  </pre>;
}

function fileEditLabel(edit: ToolCardFileEdit): string {
  if (edit.kind === "write") return runtimeText("전체 쓰기", "Write");
  if (edit.kind === "replace") return runtimeText("수정", "Edit");
  if (edit.change === "add") return runtimeText("추가", "Add");
  if (edit.change === "delete") return runtimeText("삭제", "Delete");
  return edit.movePath ? runtimeText("이동·수정", "Move & edit") : runtimeText("수정", "Edit");
}

function visibleChatToolText(text: string): string {
  const trimmed = text.trim();
  return EMPTY_JSON_LITERALS.has(trimmed) ? "" : trimmed;
}

/** `parsed`는 `text`를 JSON으로 푼 값(JSON이 아니면 undefined). */
function chatToolPreview(text: string, parsed: unknown): string {
  if (!text) return "";
  if (parsed !== null && typeof parsed === "object") {
    const value = parsed as Record<string, unknown>;
    for (const key of PREVIEW_KEYS) {
      const preview = value[key];
      if (typeof preview === "string") return preview;
    }
  }
  // 일반 텍스트 요약으로 넘어간다.
  return toolCardPreviewSource(text).replace(/\s+/g, " ").slice(0, 76);
}

function chatToolStatusLabel(status: string): string {
  return TOOL_STATUS_LABELS[status] ?? status;
}
