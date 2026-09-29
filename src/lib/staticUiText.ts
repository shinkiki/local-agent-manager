/**
 * 화면에 보이는 값에서 한국어 원문을 되짚는다. 되짚는 출처는 정적 UI 카탈로그의 역방향과
 * 제3언어 번역(`messages`)의 역방향 둘뿐이다. 둘 다 번역에 쓰는 표를 그대로 뒤집은 것이라,
 * 되짚은 원문을 다시 번역하면 지금 값이 나온다 — 이 함수가 화면을 바꾸는 일은 없다.
 *
 * 컴포넌트가 `text(ko, en)`으로 그린 영어는 되짚지 않는다. 그 역방향 표는 한국어 하나에
 * 영어가 두 벌(컴포넌트 선언·카탈로그) 있을 때 컴포넌트 쪽을 카탈로그로 덮는 통로였고,
 * 한국어 키 하나를 여러 자리가 다른 영어로 쓰는 앱에서는 마지막에 그린 자리가 이기는
 * 순서 의존까지 생겼다(QA #5·#6). 그 영어는 그린 자리의 것으로 그대로 둔다.
 */
import { untranslatableUiProperNoun } from "./uiProperNouns.ts";

export function canonicalSourceText(
  current: string,
  messages: Record<string, string>,
  staticKoreanByEnglish: ReadonlyMap<string, string>,
): string {
  const whitespace = current.match(/^(\s*)(.*?)(\s*)$/s);
  const leading = whitespace?.[1] ?? "";
  const core = whitespace?.[2] ?? current;
  const trailing = whitespace?.[3] ?? "";
  // React가 동적 값과 자식 요소 사이에 만든 공백 노드는 번역 대상으로 보지 않는다.
  // 영어에서 빈 문자열인 "개"를 역조회하면 공백이 "개"로 바뀔 수 있다.
  if (!core) return current;
  // 숫자만 있는 노드도 마찬가지다. 화면에 그린 개수("3")는 어느 문장의 번역문도 아닌데,
  // 제3언어 번역값이 숫자뿐인 항목(`${n}회` → `${n}`)이 있으면 그 숫자와 우연히 같아져
  // 엉뚱한 단위가 붙는다("3" → "3회"). 글자가 하나도 없으면 되돌릴 원문이 없다고 본다.
  if (!/\p{L}/u.test(core)) return current;
  // 어느 언어에서도 같은 글자로 부르는 고유명사는 되짚지 않는다. 이 이름은 번역문이 아니라
  // 화면이 처음부터 그렇게 그린 값인데, 역방향 표는 글자만 보고 번역문으로 읽는다 — 애드온
  // 탭이 `클로드`라는 한국어 라벨을 따로 두고 있어 생성 카탈로그에 `클로드 → Claude`가
  // 실리고, 그 표를 뒤집으면 `Claude → 클로드`가 된다. 그래서 `sourceName`이 그린 `Claude`가
  // 한국어 화면에서 `클로드`로 바뀌었다(세션 참조 공급자 칩·대시보드·세션 목록). 카탈로그를
  // 소스에서 뽑기 시작한 뒤부터(2026-09-20)이고, 그전에는 역방향 표가 손으로 적은
  // `STATIC_UI_EN`뿐이라 이 이름이 실리지 않았다. 수집 쪽은 이미 같은 판정으로 고유명사를
  // 카탈로그에서 뺀다(`getUiTranslationCatalog`).
  if (untranslatableUiProperNoun(core)) return current;
  const staticSource = staticKoreanByEnglish.get(core);
  if (staticSource !== undefined) return `${leading}${staticSource}${trailing}`;
  return `${leading}${messageSourceByTranslation(messages).get(core) ?? core}${trailing}`;
}

/**
 * 제3언어 번역표를 뒤집은 역방향. 표 하나에 한 벌만 만들어 둔다.
 *
 * 되짚기는 화면에 그려진 텍스트 노드마다 불리는데, 그 자리에서 `Object.entries(messages)`를
 * 만들어 `find`로 훑고 있었다. 노드 수 × 번역 항목 수만큼 훑는 셈이라, 화면 하나에 수백
 * 노드가 뜨고 번역표가 수천 줄인 제3언어에서는 그 곱이 그대로 렌더에 걸린다. 표는 상위가
 * `useMemo`로 들고 있어 언어가 바뀔 때만 새 객체가 되므로, 객체를 키로 역방향을 붙여 두면
 * 같은 표를 보는 동안 다시 만들지 않는다(키를 약하게 잡아 옛 표는 함께 사라진다).
 *
 * 같은 번역값을 여러 원문이 가지면 **먼저 선언된** 원문을 쓴다 — 훑기의 `find`가 주던 답과
 * 같아야 한다. 나중 것으로 덮으면 되짚은 원문이 조용히 다른 문장으로 바뀐다.
 */
const reverseMessages = new WeakMap<Record<string, string>, ReadonlyMap<string, string>>();

function messageSourceByTranslation(messages: Record<string, string>): ReadonlyMap<string, string> {
  const cached = reverseMessages.get(messages);
  if (cached) return cached;
  const reverse = new Map<string, string>();
  for (const [source, value] of Object.entries(messages)) {
    if (!reverse.has(value)) reverse.set(value, source);
  }
  reverseMessages.set(messages, reverse);
  return reverse;
}

/**
 * 카탈로그 전송 가능 판정과 수량 표현 영어 폴백은 각자 자기 파일이 소유한다. 셋은 답이
 * 달라지는 이유가 서로 달라 갈랐지만, 쓰는 쪽(정적 UI 번역)이 그 사정을 알아야 할 이유는
 * 없다 — 나눈 쪽의 사정이 호출부의 import 목록으로 새어 나가면 다음에 다시 나눌 때마다
 * 호출부를 함께 고쳐야 한다.
 */
export { sendableUiCatalogSource } from "./uiCatalogSource.ts";
export { staticEnglishFallback } from "./staticCountFallback.ts";
