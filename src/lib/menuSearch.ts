/**
 * 목록 검색어 판정 한 벌. 스킬보관함·설치된 스킬·에이전트·산출물 네 목록이 모두 "원문
 * 필드와 번역 필드를 한 줄에 모아 소문자 부분일치로 본다"는 같은 규칙을 각자 적고 있었고,
 * 비어 있는 값을 거르는 방식만 제각각이었다(`Boolean(value && …)`·`String(value)`·
 * `filter(…is string)`). 셋 다 같은 결과를 내지만 규칙을 손볼 때 고칠 자리가 넷이었다.
 * 목록마다 다른 것은 "무엇을 모으는가"뿐이라 그 배열만 받는다.
 *
 * `needle`은 이미 소문자로 다듬어진 검색어다. 빈 검색어는 호출부가 먼저 걸러 목록을
 * 그대로 돌려주므로 여기서는 다루지 않는다.
 *
 * 컴포넌트 파일(`SkillLibraryPanel.tsx`)에 있던 동안 `lib`의 `matchesSkillQuery`는 이것을
 * 가져올 수 없어(lib가 컴포넌트를 거꾸로 부르게 된다) 같은 판정을 지역 함수로 한 벌 더
 * 적고 있었다. 순수 함수라 lib에 두고 양쪽이 같은 한 벌을 쓴다.
 */
export function matchesNeedle(values: readonly (string | null | undefined)[], needle: string): boolean {
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}
