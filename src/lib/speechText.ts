/**
 * 낭독할 글 만들기 — 마크다운 표기를 걷어내고, 재생기가 한 번에 받을 수 있는 길이로 조각낸다.
 *
 * 음성 모듈(`voice`)이 함께 들고 있었지만 여기는 브라우저도 로케일도 보지 않는다. 실행
 * 환경을 묻는 일은 `speechRecognition`이, 상태·오류 문구를 한국어·영어 짝으로 내주는 일은
 * `voiceText`가 각자 소유하고, 여기는 글자만 보고 답이 정해진다.
 *
 * 한 파일에 두면 조각 경계 규칙을 고치러 온 사람이 음성 인식 타입 선언과 문구 표를 함께
 * 읽고, 문구를 한 줄 고치러 온 사람이 정규식 표를 지나쳐야 한다. 셋이 같이 쓰는 것도 없어
 * (문구는 조각내기가 읽지 않고, 조각내기는 문구도 탐지도 부르지 않는다) 그대로 가른다.
 */

/**
 * 음성 낭독에서 걷어낼 마크다운 표기. 코드 펜스부터 인라인 표기 순으로 적용해야
 * 안쪽 텍스트를 보존하므로, 치환 순서까지 이 표 한 벌이 소유한다.
 */
const SPEECH_MARKDOWN_REPLACEMENTS: readonly (readonly [pattern: RegExp, replacement: string])[] = [
  [/```[^\n]*\n([\s\S]*?)```/g, "$1"],
  [/`([^`]+)`/g, "$1"],
  [/!\[([^\]]*)\]\([^)]*\)/g, "$1"],
  [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/^\s{0,3}#{1,6}\s+/gm, ""],
  [/^\s*>\s?/gm, ""],
  [/^\s*[-*+]\s+/gm, ""],
  [/^\s*\d+[.)]\s+/gm, ""],
  [/[|*_~]/g, " "],
];

export function speechTextFromMarkdown(markdown: string): string {
  return SPEECH_MARKDOWN_REPLACEMENTS
    .reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), markdown)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 문장이 끝났다고 볼 표기. 마지막 글자까지 포함해 끊으므로 종결 부호를 그대로 둔다.
 *
 * 한국어 종결어미를 함께 잡는 후보("다. ")는 두지 않는다 — 같은 자리를 ". "가 한 칸
 * 뒤에서 잡아 언제나 그쪽이 더 뒤이므로, 후보로 남겨 두어도 한 번도 뽑히지 않는다.
 */
const SPEECH_SENTENCE_BREAKS = [". ", "! ", "? ", "。"] as const;

/**
 * 문장 끝을 조각 경계로 채택하는 최소 위치(상한 대비 비율). 이보다 앞에서 끝난 문장을
 * 따르면 조각 하나가 지나치게 짧아져 재생이 자주 끊긴다.
 */
const SPEECH_SENTENCE_BREAK_RATIO = 0.45;

/**
 * 남은 글에서 조각 하나를 어디까지 가져갈지. 상한 안의 마지막 문장 끝을 먼저 보고,
 * 그 자리가 너무 앞이면 마지막 공백에서, 공백조차 없는 긴 덩이면 상한에서 그대로 자른다.
 *
 * 세 갈래가 정하는 것은 끊는 위치 하나뿐이라 판정만 여기 두고, 잘라 담는 일은 호출부가 한다.
 */
function speechChunkEnd(remaining: string, maximumLength: number): number {
  // 상한 바로 다음 글자까지 본다. 종결 부호가 상한에 걸쳐 있어도 그 자리를 놓치지 않는다.
  const windowText = remaining.slice(0, maximumLength + 1);
  const sentenceEnd = Math.max(...SPEECH_SENTENCE_BREAKS.map((mark) => windowText.lastIndexOf(mark)));
  if (sentenceEnd >= Math.floor(maximumLength * SPEECH_SENTENCE_BREAK_RATIO)) return sentenceEnd + 1;
  const whitespace = windowText.lastIndexOf(" ");
  return whitespace > 0 ? whitespace : maximumLength;
}

export function splitSpeechText(text: string, maximumLength = 240): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maximumLength) {
    const end = speechChunkEnd(remaining, maximumLength);
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
