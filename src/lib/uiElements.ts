import { isElementVisible } from "./uiElementDom.ts";
import { matchUiElementLocator, uiRefSelector, type UiElementCandidate } from "./uiElementMatch.ts";
import { uiElementRole, uiElementText } from "./uiElementName.ts";
import type { UiElementLocator } from "../types";

// AIA 화면 안내의 "등록되지 않은 요소" 경로. AIA는 DOM을 보지 못하므로 화면이 지금 보이는
// 조작 요소를 스캔해 텍스트·역할·ref로 요약해 주고(find_ui_elements), AIA가 고른 ref나
// 텍스트를 다시 요소로 되찾아(show_ui_guide element) 가리킨다. 여기는 그중 **화면을 훑어
// 요약을 만들고 요소를 되찾는** 절차이고, 나머지 셋은 각자 자기 파일이 소유한다 —
// 요약 하나를 query·단서와 견주는 순수한 점수 기계는 `uiElementMatch`, 요소 하나를
// 무엇이라 부를지는 `uiElementName`, 눌러도 되는지는 `uiElementClick`이다. 요소를 지목하는
// 선택자와 자리 차지 판정은 화면 안내 쪽도 함께 보므로 `uiElementDom`이 따로 소유한다.

/**
 * 쓰는 쪽이 보는 입구는 이 모듈 하나다. 점수 기계는 DOM 없이 돌아야 해서, 이름 읽기와 클릭
 * 정책은 서로 다른 이유로 바뀌어서 따로 두었지만, 화면 조작 경로가 어느 판정이 어디로 갔는지
 * 알아야 할 이유는 없다 — 나눈 쪽의 사정이 호출부의 import 목록으로 새어 나가면 다음에 다시
 * 나눌 때마다 호출부를 함께 고쳐야 한다.
 */
export {
  matchUiElementLocator,
  normalizeUiText,
  rankUiElements,
  scoreUiElement,
  uiRefSelector,
  type UiElementCandidate,
} from "./uiElementMatch.ts";
export {
  activateUiElement,
  isUiOpener,
  uiClickRefusal,
  type UiClickMode,
} from "./uiElementClick.ts";

const UI_ELEMENT_SELECTOR = [
  "button", "a[href]", 'input:not([type="hidden"])', "select", "textarea", "summary",
  '[role="button"]', '[role="tab"]', '[role="radio"]', '[role="checkbox"]', '[role="link"]', '[role="menuitem"]', '[role="switch"]',
  '[contenteditable="true"]',
].join(", ");

/** 스캔 때 붙인 ref로 지금도 보이는 요소를 되찾는다. */
function visibleUiRefElement(root: ParentNode, ref: string): Element | null {
  const element = root.querySelector(uiRefSelector(ref));
  return element && isElementVisible(element) ? element : null;
}

let refCounter = 0;
function nextUiRef(): string {
  refCounter += 1;
  return `ui-${Date.now().toString(36)}-${refCounter}`;
}

/**
 * 스캔이 만든 요약 하나와 그것을 만든 요소. 요약(`UiElementCandidate`)은 AIA에게 보내는
 * 값이라 DOM을 담을 수 없지만, 같은 화면 안에서 곧바로 그 요소를 조작하는 쪽은 요약을 다시
 * 요소로 되돌릴 필요가 없다 — 스캔이 이미 손에 쥐고 있던 것을 그대로 들고 다닌다.
 */
interface ScannedUiElement {
  element: Element;
  candidate: UiElementCandidate;
}

/**
 * 지금 보이는 조작 요소를 요약한다. AIA 팝업과 안내 포인터 자체는 대상이 아니다. 요소에
 * `data-ui-ref`가 없으면 붙여 두어 AIA가 같은 요소를 되찾을 수 있게 한다.
 */
function scanVisibleUiElements(root: ParentNode): ScannedUiElement[] {
  const scanned: ScannedUiElement[] = [];
  for (const element of Array.from(root.querySelectorAll(UI_ELEMENT_SELECTOR))) {
    if (element.closest(".aia-chat-popup, .ui-guide")) continue;
    if (!isElementVisible(element)) continue;
    const text = uiElementText(element);
    if (!text) continue;
    let ref = element.getAttribute("data-ui-ref");
    if (!ref) {
      ref = nextUiRef();
      element.setAttribute("data-ui-ref", ref);
    }
    scanned.push({
      element,
      candidate: { ref, role: uiElementRole(element), text, anchor: element.getAttribute("data-ui-anchor") },
    });
  }
  return scanned;
}

/** AIA에게 보낼 요약만. 요소는 화면 밖으로 나가지 않는다. */
export function collectVisibleUiElements(root: ParentNode = document): UiElementCandidate[] {
  return scanVisibleUiElements(root).map((scanned) => scanned.candidate);
}

/**
 * AIA가 넘긴 단서로 화면의 요소를 되찾는다. ref가 살아 있고 보이면 그대로, 아니면 텍스트로 재탐색.
 *
 * 재탐색은 스캔이 쥐고 있던 요소를 그대로 쓴다. 예전에는 뽑은 요약의 ref로 DOM을 한 번 더
 * 조회해 되돌렸는데, 그 왕복은 방금 보인다고 확인한 요소를 다시 찾아 다시 보이는지 보는
 * 일이었고, 그 사이에 같은 ref가 다른 요소로 옮겨 가거나(스캔이 붙인 값이 복제된 노드에
 * 딸려간 경우) 화면이 다시 그려지면 고른 것과 다른 요소를 돌려주거나 `null`이 됐다.
 */
export function locateUiElement(locator: UiElementLocator, root: ParentNode = document): Element | null {
  if (locator.ref) {
    const direct = visibleUiRefElement(root, locator.ref);
    if (direct) return direct;
  }
  const scanned = scanVisibleUiElements(root);
  const match = matchUiElementLocator(scanned.map((item) => item.candidate), locator);
  return scanned.find((item) => item.candidate === match)?.element ?? null;
}
