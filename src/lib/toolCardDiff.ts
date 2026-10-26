/**
 * 파일을 고친 도구 카드의 인자를 파일별 변경으로 푼다.
 *
 * 왜 필요한가. 도구 카드는 인자를 JSON 원문으로 보여 준다. Claude `Edit`의 `old_string`·
 * `new_string`은 `\n`이 섞인 한 줄 문자열로, Codex `파일 변경`의 diff는 JSON 문자열 안에 갇혀
 * 나와서 무엇을 바꿨는지 읽을 수 없었다. 머리줄 미리보기도 Codex 쪽은 경로가 배열 안에
 * 있어 `[{"path"…`로 나왔다.
 *
 * 받는 모양은 넷이다.
 * - Claude `Edit` `{file_path, old_string, new_string, replace_all?}`
 * - Claude `MultiEdit` `{file_path, edits: [{old_string, new_string, replace_all?}]}`
 * - Claude `Write` `{file_path, content}` — 이전 내용은 인자에 없다.
 * - Codex 실행 중 카드 `[{path, kind: {type, move_path?}, diff}]`(app-server v2 `FileUpdateChange`)
 *   와 지난 기록의 `FileChange` 항목 `{<path>: {type, unified_diff | content, move_path?}}`.
 *   더 옛 기록의 `{<path>: {update: {unified_diff}}}` 모양도 같은 자리로 읽는다.
 *
 * Claude 쪽은 인자 모양이 흔해(`{file_path, content}`) 도구 이름으로 가르고, Codex 쪽은 이름이
 * 화면 문구(`파일 변경`)라 바뀔 수 있어 모양으로 가른다. 어느 쪽도 아니면 null — 카드는 원문
 * 그대로 그린다.
 *
 * 행 계산(`fileEditRows`)은 펼친 카드에서만 부른다. 줄 비교는 LCS라 대화에 카드가 수백 개면
 * 머리줄을 그릴 때마다 계산할 수 없다.
 */

import { collapseUnchanged, diffLines } from "./textDiff.ts";
import { parseUnifiedDiff, type UnifiedDiffRow } from "./unifiedDiff.ts";

export type ToolCardFileEdit =
  /** 문자열 바꾸기. 바꾼 조각만 알고 파일 안의 위치는 모르므로 줄 번호가 없다. */
  | { kind: "replace"; path: string; pairs: ReplacePair[] }
  /** 파일 전체 쓰기. 이전 내용을 모르므로 새 내용 전부를 추가 줄로 본다. */
  | { kind: "write"; path: string; content: string }
  /** Codex 패치. `update`의 `body`는 unified diff, `add`·`delete`는 파일 내용이다. */
  | { kind: "patch"; path: string; change: "add" | "delete" | "update"; movePath: string | null; body: string };

export interface ReplacePair {
  before: string;
  after: string;
  replaceAll: boolean;
}

export type ToolCardDiffRow =
  | UnifiedDiffRow
  /** 접힌 동일 구간. */
  | { kind: "skip"; count: number }
  /** MultiEdit의 편집 사이 구분선. `index`는 1부터. */
  | { kind: "editBoundary"; index: number; total: number; replaceAll: boolean };

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
const PATCH_CHANGES = new Set(["add", "delete", "update"]);
/** 본문 첫 줄이 hunk 머리말이면 unified diff다. 중간의 `@@ -`(패치 파일을 추가한 경우)는 내용이다. */
const HUNK_START = /^@@@? -\d/;

/** 도구 이름과 카드 인자(JSON 원문 또는 이미 푼 값)에서 파일별 변경을 꺼낸다. 아니면 null. */
export function toolCardFileEdits(name: string, detail: unknown): ToolCardFileEdit[] | null {
  const value = typeof detail === "string" ? parseToolCardJson(detail) : detail;
  if (value === undefined || value === null || typeof value !== "object") return null;
  if (CLAUDE_EDIT_TOOLS.has(name)) return claudeEdit(name, value as Record<string, unknown>);
  if (Array.isArray(value)) return codexChangeList(value);
  return codexChangeMap(value as Record<string, unknown>);
}

/** 머리줄 미리보기 — 첫 파일 경로, 여럿이면 나머지 개수. */
export function toolCardEditPreview(edits: ToolCardFileEdit[]): string {
  const first = edits[0];
  if (!first) return "";
  const path = first.kind === "patch" && first.movePath ? `${first.path} → ${first.movePath}` : first.path;
  return edits.length > 1 ? `${path} +${edits.length - 1}` : path;
}

/** 펼친 카드가 그릴 행. 바꾸기 조각은 바뀐 줄 앞뒤 3줄만 남기고 접는다. */
export function fileEditRows(edit: ToolCardFileEdit): ToolCardDiffRow[] {
  if (edit.kind === "write") return wholeFileRows(edit.content, "add");
  if (edit.kind === "patch") {
    if (edit.change !== "update" && !HUNK_START.test(edit.body)) return wholeFileRows(edit.body, edit.change === "add" ? "add" : "remove");
    return parseUnifiedDiff(edit.body);
  }
  const rows: ToolCardDiffRow[] = [];
  edit.pairs.forEach((pair, index) => {
    if (edit.pairs.length > 1 || pair.replaceAll) {
      rows.push({ kind: "editBoundary", index: index + 1, total: edit.pairs.length, replaceAll: pair.replaceAll });
    }
    for (const row of collapseUnchanged(diffLines(pair.before, pair.after))) {
      if (row.kind === "skip") rows.push(row);
      else rows.push({ kind: row.kind === "same" ? "context" : row.kind, before: null, after: null, text: row.text });
    }
  });
  return rows;
}

export function toolCardDiffStats(rows: ToolCardDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "remove") removed += 1;
  }
  return { added, removed };
}

function claudeEdit(name: string, input: Record<string, unknown>): ToolCardFileEdit[] | null {
  const path = input.file_path;
  if (typeof path !== "string" || path === "") return null;
  if (name === "Write") {
    return typeof input.content === "string" ? [{ kind: "write", path, content: input.content }] : null;
  }
  const raw = name === "MultiEdit" ? input.edits : [input];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const pairs: ReplacePair[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") return null;
    const { old_string: before, new_string: after, replace_all: replaceAll } = item as Record<string, unknown>;
    if (typeof before !== "string" || typeof after !== "string") return null;
    pairs.push({ before, after, replaceAll: replaceAll === true });
  }
  return [{ kind: "replace", path, pairs }];
}

/** 실행 중 카드: `[{path, kind: {type, move_path}, diff}]`. 한 항목이라도 모양이 다르면 아니다. */
function codexChangeList(items: unknown[]): ToolCardFileEdit[] | null {
  if (items.length === 0) return null;
  const edits: ToolCardFileEdit[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") return null;
    const { path, kind, diff } = item as Record<string, unknown>;
    if (typeof path !== "string" || typeof diff !== "string") return null;
    const change = patchKind(kind);
    if (change === null) return null;
    edits.push({ kind: "patch", path, change: change.type, movePath: change.movePath, body: diff });
  }
  return edits;
}

/** 지난 기록: `{<path>: {type, unified_diff | content, move_path}}` 또는 `{<path>: {update: {...}}}`. */
function codexChangeMap(map: Record<string, unknown>): ToolCardFileEdit[] | null {
  const entries = Object.entries(map);
  if (entries.length === 0) return null;
  const edits: ToolCardFileEdit[] = [];
  for (const [path, raw] of entries) {
    if (raw === null || typeof raw !== "object") return null;
    let change = raw as Record<string, unknown>;
    let type = change.type;
    if (typeof type !== "string") {
      // 옛 모양은 종류가 키 하나다.
      const keys = Object.keys(change);
      if (keys.length !== 1) return null;
      type = keys[0];
      const inner = change[keys[0]];
      if (inner === null || typeof inner !== "object") return null;
      change = inner as Record<string, unknown>;
    }
    // 배열과 맵이 변경 종류·이동 경로를 같은 규칙으로 읽는다.
    const kind = patchKind({ type, move_path: change.move_path });
    if (kind === null) return null;
    const body = kind.type === "update" ? change.unified_diff : change.content;
    if (typeof body !== "string") return null;
    edits.push({ kind: "patch", path, change: kind.type, movePath: kind.movePath, body });
  }
  return edits;
}

function patchKind(kind: unknown): { type: "add" | "delete" | "update"; movePath: string | null } | null {
  if (kind === null || typeof kind !== "object") return null;
  const { type, move_path: movePath } = kind as Record<string, unknown>;
  if (typeof type !== "string" || !PATCH_CHANGES.has(type)) return null;
  return { type: type as "add" | "delete" | "update", movePath: typeof movePath === "string" && movePath !== "" ? movePath : null };
}

function wholeFileRows(content: string, kind: "add" | "remove"): UnifiedDiffRow[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, index) => kind === "add"
    ? { kind, before: null, after: index + 1, text }
    : { kind, before: index + 1, after: null, text });
}

/** 카드 인자 원문을 JSON으로 푼다. JSON이 아니면 undefined. */
export function parseToolCardJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
