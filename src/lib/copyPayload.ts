export function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function joinMarkdownBlocks(blocks: string[]): string {
  return blocks
    .map((block) => normalizeClipboardText(block).trim())
    .filter(Boolean)
    .join("\n\n");
}

export function markdownSectionAtLine(source: string, headingLine: number): string {
  const lines = normalizeClipboardText(source).split("\n");
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
