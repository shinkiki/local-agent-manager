/**
 * 도구 카드 본문을 화면이 감당할 크기로 묶는다.
 *
 * 왜 필요한가. Codex의 `파일 변경` 카드는 diff 전체를, `명령 실행`과 시스템 도구 카드는
 * 출력 전체를 한 문자열로 들고 온다. 한 AIA 대화에서 50만 자짜리 한 줄(JSON으로 감싼 diff,
 * `git show` 안의 압축 HTML)이 카드 하나에 실려 왔고, 그 `<pre>` 하나를 WebKit이 펼쳐
 * 그리는 데 190ms가 걸렸다(2026-10-05 실측, 760px 폭·pre-wrap). 완료된 카드라면 한 번이지만,
 * 실행 중인 카드는 출력 조각이 올 때마다 본문이 바뀌어 매번 다시 그리므로 조각 수 × 190ms가
 * 화면을 멈춘다. 그려지는 글자 수를 여기서 묶으면 조각마다 드는 비용이 상수가 된다.
 *
 * 전체 글은 그대로 들고 있다 — 사용자가 '전체 보기'를 누르면 한 번의 비용으로 다 그린다.
 */

/** `<pre>` 하나에 기본으로 그리는 최대 글자 수(UTF-16 코드 단위). */
export const MAX_TOOL_CARD_TEXT_CHARS = 32_000;

/**
 * 카드 머리줄 미리보기를 만들 때 읽는 앞부분 길이. 미리보기는 76자만 쓰는데 정규식이
 * 본문 전체를 훑고 있었다 — 50만 자 카드 94개면 한 번 그릴 때 18ms다.
 */
export const TOOL_CARD_PREVIEW_SOURCE_CHARS = 2_048;

export interface BoundedToolCardText {
  /** 실제로 그릴 글. 상한 안이면 원문 그대로다. */
  text: string;
  /** 그리지 않은 글자 수. 0이면 잘리지 않았다. */
  omitted: number;
  /** 원문 전체 글자 수. */
  total: number;
}

/**
 * 본문을 상한 안으로 묶는다. 실행 중인 카드는 뒤쪽(지금 흐르는 줄)을, 끝난 카드는 앞쪽
 * (명령·인자·결과 머리)을 남긴다. 상한 아래에서는 원문을 그대로 돌려주므로 `omitted`가
 * 0인지로 잘림 여부를 가른다.
 */
export function boundToolCardText(text: string, keep: "head" | "tail", limit = MAX_TOOL_CARD_TEXT_CHARS): BoundedToolCardText {
  const total = text.length;
  if (total <= limit) return { text, omitted: 0, total };
  const kept = keep === "tail" ? text.slice(total - limit) : text.slice(0, limit);
  return { text: kept, omitted: total - limit, total };
}

/** 미리보기 정규식이 읽을 앞부분. 짧은 글은 그대로다. */
export function toolCardPreviewSource(text: string): string {
  return text.length <= TOOL_CARD_PREVIEW_SOURCE_CHARS ? text : text.slice(0, TOOL_CARD_PREVIEW_SOURCE_CHARS);
}

/** 글자 수를 사람이 읽는 단위로. 카드의 생략 안내가 쓴다. */
export function formatCharCount(count: number): string {
  if (count < 10_000) return count.toLocaleString();
  return `${(count / 10_000).toFixed(count < 100_000 ? 1 : 0)}만`;
}
