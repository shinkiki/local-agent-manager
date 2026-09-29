/**
 * 언어를 바꿔도 그대로 두는 고유명사.
 *
 * 제3언어 UI 번역은 화면에서 거둔 문구를 통째로 모델에 넘긴다. 그러면 낱말 하나로 그려진
 * 제품·기능 이름도 번역 대상이 되어, 모델이 뜻을 옮길 것이 없으니 소리를 옮긴다 — 상단바의
 * `AIA`가 "아이아"로 돌아오는 식이다. 이런 이름은 어느 언어에서도 같은 글자로 부르는 영어
 * 고유명사이므로 애초에 카탈로그에 싣지 않는다. 카탈로그에 없는 원문은 번역값이 없어
 * 영어 정본으로 떨어지고(`localizedUiText`), 정본이 곧 원문이라 화면 값이 그대로 남는다.
 *
 * 이름이 문장 안에 섞인 문구("AIA 열기")는 여기서 거르지 않는다 — 나머지 말은 번역해야
 * 하므로, 이름을 지키는 일은 번역 프롬프트(`translation.rs`)가 맡는다.
 */
const UI_PROPER_NOUNS: ReadonlySet<string> = new Set([
  "AIA",
  "Agent Manager",
  "Claude",
  "Codex",
  "Antigravity",
  "Cypress",
  "Notion",
  "MCP",
  "SSH",
]);

export function untranslatableUiProperNoun(source: string): boolean {
  return UI_PROPER_NOUNS.has(source.trim());
}
