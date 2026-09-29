/**
 * 길이 상한이 걸린 문자열을 다룰 때 쓰는 두 밑돌 — 유니코드 문자 단위로 세는 일과,
 * 공백을 한 칸으로 접는 일.
 *
 * 두 규칙은 Rust Core의 `text_limit.rs`와 짝을 이룬다. 그쪽이 `chars()`로 세므로 여기도
 * 코드 포인트로 세야 같은 값을 같은 길이로 본다. 그런데 그 셈이 자리마다 손으로 펼친
 * `[...value].length`로 적혀 있었다 — 계정 텍스트 초안·AIA 명령 상한·대화 미리보기 셋이
 * 각자 한 줄씩 갖고, 어느 자리에서 `.length`(UTF-16 코드 단위)로 적어도 형식 오류가 나지
 * 않는다. 이모지나 서로게이트 쌍이 섞인 입력에서만 프런트와 Core의 판정이 갈리고, 그때도
 * 오류가 아니라 "화면은 통과시켰는데 저장이 거절당한다"로 조용히 드러난다.
 *
 * 공백 접기도 같다. `split(/\s+/u).filter(Boolean).join(" ")`는 앞뒤 공백 제거와 연속 공백
 * 접기를 한 문장으로 하는 관용구인데, `\s`에 `u` 플래그를 빠뜨리거나 `filter(Boolean)`를
 * 잊으면 빈 조각이 남아 앞뒤에 공백이 붙는다. 한 벌로 두면 그 갈림이 생기지 않는다.
 *
 * 상한 값 자체는 여기 두지 않는다. 무엇을 몇 자까지 담을지는 담는 쪽이 정하고, 이 모듈은
 * "어떻게 세고 어떻게 접는가"만 안다.
 */

/** 문자열을 유니코드 문자(코드 포인트) 배열로 편다. 자를 자리를 문자 단위로 찾을 때 쓴다. */
export function textCharacters(value: string): string[] {
  return [...value];
}

/** 유니코드 문자 수. 값이 없으면 0자로 센다. Rust `text_limit.rs`의 `chars().count()`와 같다. */
export function countTextCharacters(value: string | null | undefined): number {
  return value ? textCharacters(value).length : 0;
}

/** 앞뒤 공백을 걷고 연속 공백·줄바꿈을 한 칸으로 접는다. 값이 없으면 빈 문자열이다. */
export function collapseWhitespace(value: string | null | undefined): string {
  return (value ?? "").split(/\s+/u).filter(Boolean).join(" ");
}
