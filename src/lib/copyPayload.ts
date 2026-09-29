const HEADING_PATTERN = /^(#{1,6})\s+.+$/;
const CODE_FENCE_PATTERN = /^\s*```/;

function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 마크다운 제목 줄에서 수준(# 개수)을 꺼낸다. 제목이 아니면 null. */
function headingLevel(line?: string): number | null {
  const match = line?.match(HEADING_PATTERN);
  return match ? match[1].length : null;
}

/** 코드 블록 펜스(```) 줄인지 확인한다. */
function isCodeFence(line: string): boolean {
  return CODE_FENCE_PATTERN.test(line);
}

export function joinMarkdownBlocks(blocks: string[]): string {
  return blocks
    .map((block) => normalizeClipboardText(block).trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 시작 제목 줄 다음부터 현재 제목 수준 이하의 다음 제목이 나타나는 줄 번호를 찾는다.
 * 코드 블록 펜스 안의 제목은 무시하며, 다음 제목이 없으면 전체 줄 수를 돌려준다.
 */
function findNextSectionBoundary(lines: string[], headingLine: number, level: number): number {
  let fenced = false;
  for (let index = headingLine + 1; index < lines.length; index += 1) {
    if (isCodeFence(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const nextLevel = headingLevel(lines[index]);
    if (nextLevel !== null && nextLevel <= level) {
      return index;
    }
  }
  return lines.length;
}

/**
 * 줄 단위로 이미 나눠 둔 원문에서 섹션을 잘라낸다. 제목마다 원문을 다시 쪼개면 제목 수
 * × 원문 길이만큼 일하게 되므로, 렌더당 한 번 나눈 줄을 넘겨 재사용한다.
 */
export function markdownSectionFromLines(lines: string[], headingLine: number): string {
  const level = headingLevel(lines[headingLine]);
  if (level === null) return "";

  const end = findNextSectionBoundary(lines, headingLine, level);
  return lines.slice(headingLine, end).join("\n").trimEnd();
}

