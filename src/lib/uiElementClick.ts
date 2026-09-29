import { uiElementRole } from "./uiElementName.ts";

/**
 * AIA 커서가 **무엇을 눌러도 되는지**를 정하는 자리. 승인 없이 눌러도 되는 "여는 동작"의
 * 범위와, 클릭 권한이 '모든 클릭'이어도 열지 않는 금지 구역이 여기 한 벌만 있다.
 *
 * 스캔·요약(`uiElements`)에서 떼어 둔 것은 이 규칙이 보안 경계이기 때문이다. 화면을 훑는
 * 선택자나 ref 발급이 바뀌는 일과 "승인 카드는 누르지 않는다"가 바뀌는 일은 서로 다른
 * 이유로 일어나는데, 한 파일에 있으면 스캔을 고치러 온 변경이 금지 표 옆을 지나가고
 * 리뷰도 그 둘을 한 덩어리로 본다.
 */

const EXPANDABLE_ARIA_ATTRIBUTES = ["aria-expanded", "aria-haspopup", "aria-controls"] as const;

function hasExpandableAria(element: Element): boolean {
  return EXPANDABLE_ARIA_ATTRIBUTES.some((attr) => element.hasAttribute(attr));
}

/**
 * AIA 커서가 승인 없이 눌러도 되는 "여는 동작"인지. 탭·주 메뉴·등록 대상, 펼침 상태를 가진
 * 버튼(aria-expanded/haspopup/controls), details의 summary가 여기 든다. 화면을 바꾸기만 하고
 * 되돌릴 수 있는 조작이라는 뜻이다.
 */
export function isUiOpener(element: Element): boolean {
  if (element.hasAttribute("data-ui-anchor")) return true;
  if (element.getAttribute("role") === "tab") return true;
  if (hasExpandableAria(element)) return true;
  if (element.tagName.toLowerCase() === "summary") return true;
  return Boolean(element.closest("nav"));
}

export type UiClickMode = "open" | "click";

const REFUSED_CONTAINERS: readonly { selector: string; reason: string }[] = [
  { selector: ".modal-backdrop", reason: "확인 모달 안의 버튼은 AIA가 누르지 않습니다. 사용자가 직접 결정해야 합니다" },
  { selector: ".aia-chat-popup", reason: "AIA 팝업 안의 요소는 누르지 않습니다" },
  // C9-17. 승인 카드는 "사용자가 직접 결정했다"가 유일한 근거인 자리다. 클릭 권한이
  // '모든 클릭'이어도 여기는 열지 않는다 — AIA 커서가 자기 요청의 승인 버튼을 누를 수
  // 있으면 SSH 1회 승인이든 공급자 권한 요청이든 승인이라는 개념 자체가 남지 않는다.
  { selector: ".chat-approval", reason: "승인 카드의 버튼은 AIA가 누르지 않습니다. 승인은 사용자가 직접 결정해야 합니다" },
];

function isElementDisabled(element: Element): boolean {
  return Boolean((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true");
}

/** 누르면 안 되는 이유. null이면 눌러도 된다. */
export function uiClickRefusal(element: Element, mode: UiClickMode): string | null {
  for (const { selector, reason } of REFUSED_CONTAINERS) {
    if (element.closest(selector)) return reason;
  }
  if (isElementDisabled(element)) return "비활성화된 요소입니다";
  if (mode === "open" && !isUiOpener(element)) {
    return "화면을 여는 동작이 아닌 버튼입니다. 사용자가 이 조작을 요청했다면 click_ui_element(승인)를 쓰세요";
  }
  return null;
}

/** 요소를 실제로 조작한다. 입력은 클릭 대신 포커스만 준다. */
export function activateUiElement(element: Element): void {
  const target = element as HTMLElement;
  target.focus();
  const role = uiElementRole(element);
  if (role !== "textbox" && role !== "select") {
    target.click();
  }
}
