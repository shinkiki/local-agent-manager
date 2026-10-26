/**
 * 표 블록의 줄 문법. 머리 줄 바로 다음 줄이 정렬 지정(`---`, `:---:`)이어야 표가 시작한다.
 *
 * 머리 줄과 정렬 줄의 칸 수가 같아야 한다(GFM과 같은 규칙). 예전에는 정렬 줄만 따로 보았기
 * 때문에, `|`가 들어간 평범한 문장 바로 뒤에 구분선 `---`을 적으면 그 `---`이 한 칸짜리
 * 정렬 줄로 읽혀 문장이 본문 없는 표 머리로 바뀌고 구분선은 사라졌다. 셸 파이프나 `a | b`
 * 같은 표기를 담은 문단 뒤에 구분선을 두는 일은 답변에서 흔하다.
 */

export function startsMarkdownTable(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length || !lines[index].includes("|")) return false;
  const separator = splitMarkdownTableRow(lines[index + 1]);
  return isMarkdownTableSeparator(separator)
    && separator.length === splitMarkdownTableRow(lines[index]).length;
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

/**
 * 앞뒤 파이프 하나씩을 걷어 내고 칸으로 나눈다. 이스케이프한 `\|`는 칸 경계가 아니라 글자다 —
 * 칸 수를 맞춰 보게 된 뒤로 그것을 경계로 세면 `| a \| b | c |` 같은 두 칸 표가 표가 아니게
 * 된다. 칸 안에 남은 `\|`는 인라인 렌더러가 `|`로 그린다.
 */
export function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

export function markdownTableAlignment(cell: string): "left" | "center" | "right" {
  const value = cell.replace(/\s/g, "");
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}
