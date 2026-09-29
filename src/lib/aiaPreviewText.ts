/**
 * 대화 미리보기 한 줄을 정해진 글자 수 안으로 줄이는 규칙.
 *
 * 이 규칙은 알림을 고르는 일과 아무 관계가 없다. 그런데 말풍선 조립이 알림 선택과
 * 한 파일에 있던 탓에, 공백 접기·문장 경계 탐색·`text_limit.rs`와 맞춘 되돌림 비율이
 * "AIA 알림 중 무엇을 띄울 것인가"를 읽으러 온 자리에 함께 놓여 있었다. 상한 하나를
 * 옮기려 해도 알림 선택 규칙을 지나쳐 읽어야 했고, 반대로 선택 규칙을 볼 때는 글자
 * 자르기 세 함수가 파일의 절반을 차지했다.
 *
 * 문구를 어디에 띄울지(상한 값)는 띄우는 쪽이 정하고, 여기서는 "주어진 상한 안에서
 * 어디를 끊을 것인가"만 안다. 그래서 상한은 인자로만 받고 이 모듈에 상수로 두지 않는다.
 *
 * 문자 수를 세는 일과 공백을 접는 일은 `boundedText.ts`가 갖는다 — 상한이 걸린 자리라면
 * 어디서나 같은 기준이어야 하고, 이 모듈만 아는 규칙이 아니다.
 */
import { collapseWhitespace, textCharacters } from "./boundedText.ts";

/** 상한의 몇 %보다 뒤에서만 낱말·문장 경계를 찾을지. `text_limit.rs`와 같은 기준이다. */
const BOUNDARY_MIN_RATIO = 0.6;
const SENTENCE_END = /[.!?。！？…]/u;

/**
 * 공백을 한 칸으로 정리하고, 제한 글자 수를 넘으면 낱말·문장을 끊지 않는 자리에서
 * 말줄임표로 마무리한다. 남는 글자가 없으면 null이다.
 *
 * 마크다운 표기는 여기서 걷지 않는다. 대화 미리보기는 백엔드가 이미 순수 텍스트로
 * 옮겨 보내고, 이 함수가 함께 다루는 승인 요청 문구는 마크다운이 아니다.
 */
export function clampPreviewText(text: string | null | undefined, limit: number): string | null {
  const collapsed = collapseWhitespace(text);
  if (!collapsed) return null;
  const chars = textCharacters(collapsed);
  if (chars.length <= limit) return collapsed;
  return `${chars.slice(0, previewCutIndex(chars, limit)).join("").trimEnd()}…`;
}

/**
 * 상한 안쪽에서 끊을 자리를 고른다. 마지막 문장 끝을 먼저 찾고, 없으면 마지막 공백을
 * 쓴다. 상한의 `BOUNDARY_MIN_RATIO` 앞까지 물러나면 내용이 너무 줄어들므로, 그 안에
 * 경계가 없으면 상한에서 그대로 끊는다.
 */
function previewCutIndex(chars: string[], limit: number): number {
  const sentenceEnd = lastBoundaryIndex(limit, (index) => (
    // 뒤가 공백일 때만 문장 끝으로 본다. 그러지 않으면 `1.5`의 소수점에서 끊긴다.
    SENTENCE_END.test(chars[index]) && (chars[index + 1] ?? " ") === " "
  ));
  if (sentenceEnd !== null) return sentenceEnd + 1;
  return lastBoundaryIndex(limit, (index) => chars[index] === " ") ?? limit;
}

/** 상한의 허용 구간을 뒤에서부터 훑어 조건에 맞는 마지막 경계를 찾는다. */
function lastBoundaryIndex(
  limit: number,
  matches: (index: number) => boolean,
): number | null {
  const floor = Math.floor(limit * BOUNDARY_MIN_RATIO);
  for (let index = limit - 1; index >= floor; index -= 1) {
    if (matches(index)) return index;
  }
  return null;
}
