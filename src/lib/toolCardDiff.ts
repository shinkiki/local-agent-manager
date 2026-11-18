/**
 * 파일별 변경을 머리줄 미리보기와 비교 행으로 만든다.
 * 입력 형식 해석은 toolCardFileEdits.ts가 맡고, 기존 호출부는 여기서 그대로 가져온다.
 * 행 계산은 펼친 카드에서만 부른다. 줄 비교는 LCS라 머리줄마다 계산하지 않는다.
 */

import { collapseUnchanged, diffLines } from "./textDiff.ts";
import { parseUnifiedDiff, type UnifiedDiffRow } from "./unifiedDiff.ts";
import type { ToolCardFileEdit } from "./toolCardFileEdits.ts";

export { parseToolCardJson, toolCardFileEdits } from "./toolCardFileEdits.ts";
export type { ReplacePair, ToolCardFileEdit } from "./toolCardFileEdits.ts";

export type ToolCardDiffRow =
  | UnifiedDiffRow
  /** 접힌 동일 구간. */
  | { kind: "skip"; count: number }
  /** MultiEdit의 편집 사이 구분선. `index`는 1부터. */
  | { kind: "editBoundary"; index: number; total: number; replaceAll: boolean };

/** 본문 첫 줄이 hunk 머리말이면 unified diff다. 중간의 `@@ -`(패치 파일을 추가한 경우)는 내용이다. */
const HUNK_START = /^@@@? -\d/;

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

function wholeFileRows(content: string, kind: "add" | "remove"): UnifiedDiffRow[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, index) => kind === "add"
    ? { kind, before: null, after: index + 1, text }
    : { kind, before: index + 1, after: null, text });
}
