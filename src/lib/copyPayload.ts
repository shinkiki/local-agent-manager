function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function joinMarkdownBlocks(blocks: string[]): string {
  return blocks
    .map((block) => normalizeClipboardText(block).trim())
    .filter(Boolean)
    .join("\n\n");
}

export function markdownSectionAtLine(source: string, headingLine: number): string {
  return markdownSectionFromLines(normalizeClipboardText(source).split("\n"), headingLine);
}

/**
 * 줄 단위로 이미 나눠 둔 원문에서 섹션을 잘라낸다. 제목마다 원문을 다시 정규화하고
 * 쪼개면 제목 수 × 원문 길이만큼 일하게 되므로, 렌더당 한 번 나눈 줄을 넘겨 재사용한다.
 */
export function markdownSectionFromLines(lines: string[], headingLine: number): string {
  const heading = lines[headingLine]?.match(/^(#{1,6})\s+.+$/);
  if (!heading) return "";

  const level = heading[1].length;
  let fenced = false;
  let end = lines.length;
  for (let index = headingLine + 1; index < lines.length; index += 1) {
    if (/^\s*```/.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const nextHeading = lines[index].match(/^(#{1,6})\s+.+$/);
    if (nextHeading && nextHeading[1].length <= level) {
      end = index;
      break;
    }
  }

  return lines.slice(headingLine, end).join("\n").trimEnd();
}
