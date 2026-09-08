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
  const staticSource = staticKoreanByEnglish.get(core);
  const customSource = Object.entries(messages).find(([, value]) => value === core)?.[0];
  return `${leading}${staticSource ?? customSource ?? core}${trailing}`;
}

/**
 * 백엔드가 카탈로그 문구 하나를 512**바이트**까지만 받고(`translation.rs`의
 * `validate_ui_catalog`: `key.len() > 512`, `char::is_control`), 제어 문자가 든 문구도
 * 거절한다. 프런트 수집은 500**자**로 잘라 왔는데 한글은 한 자가 3바이트라 170자를 넘는
 * 문단 하나, 또는 줄바꿈이 든 `text()` 키 하나만 렌더돼 있어도 카탈로그 전체가 거절되고
 * UI 언어를 아예 바꿀 수 없었다(QA #18·#21). 그런 문구는 컴포넌트가 `text()`로 자기
 * 번역을 이미 들고 있어 카탈로그에 실을 이유가 없으므로 여기서 걸러 낸다. 백엔드와 같은
 * 단위(UTF-8 바이트·Unicode Cc)로 재야 한쪽만 통과하는 문구가 생기지 않는다.
 */
export const MAX_UI_CATALOG_SOURCE_BYTES = 512;
const uiCatalogEncoder = new TextEncoder();

export function sendableUiCatalogSource(source: string): boolean {
  return source.trim().length > 0
    && !/\p{Cc}/u.test(source)
    && uiCatalogEncoder.encode(source).length <= MAX_UI_CATALOG_SOURCE_BYTES;
}

/**
 * 대응표에 없는 한국어 문구의 영어 폴백. 문구 **전체**가 수량 표현일 때만 바꾸고, 그 밖에는
 * 원문을 그대로 돌려준다. 예전에는 `전체 ` → `total `처럼 문장 일부만 바꾸는 규칙이 있어,
 * 대응표에 없는 문장이 "활성 0 / total 0 · 다음 실행 순"처럼 한국어·영어가 섞인 채
 * 그려졌다(QA #51). 반쯤 번역된 문장보다 한국어 그대로가 낫고, 그런 문장은 컴포넌트가
 * `text(ko, en)`으로 온전한 영어 문장을 들고 있어야 한다.
 */
export function staticEnglishFallback(core: string): string {
  const count = core.match(/^(\d[\d,]*)(개|건|개 세션)$/);
  if (!count) return core;
  const [, number, unit] = count;
  return unit === "개" ? number : unit === "건" ? `${number} items` : `${number} sessions`;
}
