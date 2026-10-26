/**
 * unified diff 원문을 화면 행으로 푼다. `git diff` 한 파일 분량이 들어오지만 여러 파일이
 * 이어진 패치도 hunk 수를 세어 경계를 잡는다 — 다음 파일의 `--- a/x` 줄이 삭제 줄로
 * 읽히면 줄 번호가 밀려 전체가 어긋난다.
 *
 * i18n은 여기 두지 않는다. 행의 `text`는 원문 그대로이고, 화면이 종류별로 글을 붙인다.
 */

export type UnifiedDiffRowKind = "meta" | "hunk" | "add" | "remove" | "context" | "noNewline";

export interface UnifiedDiffRow {
  kind: UnifiedDiffRowKind;
  /** 변경 전 파일의 줄 번호. 추가·메타·hunk 머리말은 null. */
  before: number | null;
  /** 변경 후 파일의 줄 번호. 삭제·메타·hunk 머리말은 null. */
  after: number | null;
  /** 접두 기호(`+`·`-`·공백)를 뗀 본문. 메타·hunk 행은 줄 전체. */
  text: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/**
 * 충돌 파일의 `git diff`는 부모가 둘인 combined diff(`diff --cc`)라 hunk 머리말이 `@@@`이고
 * 줄 접두가 두 칸이다. 첫 부모 열을 "변경 전"으로 삼아 같은 행 모양으로 푼다.
 */
const COMBINED_HUNK_HEADER = /^@@@ -(\d+)(?:,(\d+))? -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@@/;

export function parseUnifiedDiff(text: string): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  const lines = text.split("\n");
  // 끝 개행 하나는 마지막 줄의 종료이지 빈 줄이 아니다.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let before = 0;
  let after = 0;
  let remainingParents: number[] = [];
  let remainingAfter = 0;
  let columns = 1;
  const inHunk = () => remainingParents.some((remaining) => remaining > 0) || remainingAfter > 0;

  for (const line of lines) {
    const combined = COMBINED_HUNK_HEADER.exec(line);
    const header = combined ?? HUNK_HEADER.exec(line);
    if (header) {
      columns = combined ? 2 : 1;
      before = Number(header[1]);
      remainingParents = [header[2] === undefined ? 1 : Number(header[2])];
      if (combined) remainingParents.push(combined[4] === undefined ? 1 : Number(combined[4]));
      const resultIndex = combined ? 5 : 3;
      after = Number(header[resultIndex]);
      remainingAfter = header[resultIndex + 1] === undefined ? 1 : Number(header[resultIndex + 1]);
      rows.push({ kind: "hunk", before: null, after: null, text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      // `\ No newline at end of file`은 줄 수에 들지 않는다.
      rows.push({ kind: "noNewline", before: null, after: null, text: line.slice(1).trim() });
      continue;
    }
    if (!inHunk()) {
      rows.push({ kind: "meta", before: null, after: null, text: line });
      continue;
    }
    const prefix = line.slice(0, columns);
    const body = line.slice(columns);
    // V4: combined diff의 ` +`는 첫 부모에도 있는 결과 줄이고, ` -`는 둘째 부모만의
    // 삭제 줄이다. 색은 어느 부모와라도 다른지를 보되, 번호와 hunk 끝은 부모별로 센다.
    const inResult = !prefix.includes("-");
    const inParents = remainingParents.map((_, index) => (
      inResult ? prefix[index] !== "+" : prefix[index] === "-"
    ));
    if (prefix.includes("+")) {
      rows.push({ kind: "add", before: null, after, text: body });
    } else if (prefix.includes("-")) {
      rows.push({ kind: "remove", before: inParents[0] ? before : null, after: null, text: body });
    } else {
      // 공백 접두, 또는 끝 공백이 잘린 빈 문맥 줄.
      rows.push({ kind: "context", before, after, text: prefix.trim() === "" && prefix.length === columns ? body : line });
    }
    if (inParents[0]) before += 1;
    remainingParents = remainingParents.map((remaining, index) => remaining - Number(inParents[index]));
    if (inResult) {
      after += 1;
      remainingAfter -= 1;
    }
  }
  return rows;
}

export function unifiedDiffStats(rows: UnifiedDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "remove") removed += 1;
  }
  return { added, removed };
}
