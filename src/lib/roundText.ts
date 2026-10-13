/**
 * 회차 목표·보고의 긴 글을 화면 문단으로 나눈다.
 *
 * 회차는 요약을 줄바꿈 없는 한 문단으로 적어 왔다(2026-10-10 기준 저장된 보고 272건 중 줄바꿈이
 * 있는 것 0건, 긴 것은 1,500자). `<p>` 하나에 그대로 넣으면 벽처럼 읽혀서, 줄바꿈이 있으면 그대로
 * 따르고 한 줄이 길면 문장 끝에서 끊어 몇 문장씩 묶는다. 저장된 글은 바꾸지 않는다.
 */

/** 한 문단에 묶을 글자 수의 대략적인 상한. 한 문장이 이보다 길면 그 문장 하나가 문단이 된다. */
export const ROUND_PARAGRAPH_CHARS = 180;

/** 문장 끝(마침표·물음표·느낌표 뒤 공백)에서 자른다. `7.3.2` 처럼 공백이 없는 점은 끊지 않는다. */
function sentences(line: string): string[] {
  return line.replace(/([.!?。])\s+/g, "$1\u0000").split("\u0000").filter((part) => part.length > 0);
}

function chunkLine(line: string, limit: number): string[] {
  if (line.length <= limit) return [line];
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences(line)) {
    if (current && current.length + 1 + sentence.length > limit) {
      paragraphs.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export function roundTextParagraphs(text: string, limit = ROUND_PARAGRAPH_CHARS): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => chunkLine(line, limit));
}
