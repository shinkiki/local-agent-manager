/**
 * 요소 하나를 **지목하고 보이는지 보는** 최소 도구 둘 — 속성 선택자 조립과 자리 차지 판정.
 *
 * 둘 다 AIA 요소 스캔(`uiElements`)이 들고 있었고, 화면 안내 쪽 두 모듈이 그 스캔 모듈을
 * 거쳐 빌려 썼다 — 대상 목록(`uiGuide`)은 앵커 선택자를, 대기 루프(`waitForVisibleElement`)는
 * 자리 차지 판정을. 그래서 JSON 한 벌을 검증하는 일과 프레임마다 요소를 다시 보는 일이
 * 둘 다 화면을 훑는 선택자·ref 발급·클릭 금지 표·점수 기계까지 함께 끌어왔다. 빌린 것은
 * 어느 쪽도 스캔의 사정을 모르는 두 줄짜리 도구인데, 그 두 줄 때문에 세 모듈이 한 덩어리로
 * 묶여 리뷰도 함께 읽고 node 시험도 함께 적재한다.
 *
 * 세 쓰임이 공통으로 보는 것만 여기 두어(창 라벨 문법을 `usageWindowLabel`에 둔 것과 같은
 * 요령) 화면 안내 두 모듈이 스캔 모듈을 전혀 읽지 않게 한다.
 */

/**
 * 속성 값을 그대로 넣는 CSS 속성 선택자. 값에 든 따옴표·역슬래시만 이스케이프한다 —
 * `data-ui-ref`·`data-ui-anchor`는 우리가 붙이거나 JSON으로 검증한 값이라 그 밖의
 * 문자는 선택자를 깨뜨리지 않는다.
 */
export function attributeSelector(attribute: string, value: string): string {
  return `[${attribute}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

/**
 * 화면에 자리를 차지하는지. 비활성 화면은 언마운트가 아니라 `hidden`으로 숨겨지므로
 * DOM에 있는 것만으로는 부족하고 실제 크기를 봐야 한다. 스캔이 요약에 올릴 요소를 고르는
 * 기준과 안내가 가리킬 요소를 기다리는 기준은 같아야 하므로 판정도 한 벌만 둔다.
 */
export function isElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
