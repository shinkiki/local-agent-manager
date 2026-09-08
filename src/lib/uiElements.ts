import type { UiElementLocator } from "../types";

// AIA 화면 안내의 "등록되지 않은 요소" 경로. AIA는 DOM을 보지 못하므로 화면이 지금 보이는
// 조작 요소를 스캔해 텍스트·역할·ref로 요약해 주고(find_ui_elements), AIA가 고른 ref나
// 텍스트를 다시 요소로 되찾아(show_ui_guide element) 가리킨다. DOM을 만지는 함수와 순수한
// 점수·매칭 함수를 나눠, 후자는 node 테스트로 검증한다.

export interface UiElementCandidate {
  /** 스캔 때 요소에 붙인 `data-ui-ref`. 요소가 다시 그려지면 사라질 수 있다. */
  ref: string;
  role: string;
  text: string;
  /** 등록 대상 앵커가 있으면 함께 알려 AIA가 안정적인 target을 고를 수 있게 한다. */
  anchor: string | null;
}

const UI_ELEMENT_SELECTOR = [
  "button", "a[href]", 'input:not([type="hidden"])', "select", "textarea", "summary",
  '[role="button"]', '[role="tab"]', '[role="radio"]', '[role="checkbox"]', '[role="link"]', '[role="menuitem"]', '[role="switch"]',
  '[contenteditable="true"]',
].join(", ");

const MAX_TEXT_CHARS = 60;
const DEFAULT_LIMIT = 12;

/** 한국어·영어로 말한 역할 단어를 role 값으로 잇는다. "저장 버튼"의 "버튼"이 button과 맞도록. */
const ROLE_WORDS: Record<string, string[]> = {
  button: ["버튼", "button", "btn"],
  tab: ["탭", "tab"],
  link: ["링크", "link"],
  textbox: ["입력", "입력창", "input", "textbox", "필드", "field"],
  select: ["선택", "드롭다운", "select", "dropdown"],
  checkbox: ["체크", "checkbox"],
  radio: ["라디오", "radio"],
  switch: ["토글", "스위치", "switch", "toggle"],
};

export function normalizeUiText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_TEXT_CHARS ? `${collapsed.slice(0, MAX_TEXT_CHARS - 1)}…` : collapsed;
}

function roleForToken(token: string): string | null {
  for (const [role, words] of Object.entries(ROLE_WORDS)) {
    if (words.includes(token)) return role;
  }
  return null;
}

/** query 토큰이 텍스트·역할과 얼마나 맞는지. 0이면 후보가 아니다. 빈 query는 모두 1점. */
export function scoreUiElement(candidate: Pick<UiElementCandidate, "text" | "role">, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  const text = candidate.text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (text === token) score += 5;
    else if (text.includes(token)) score += 3;
    else if (roleForToken(token) === candidate.role || candidate.role === token) score += 1;
  }
  return score;
}

export function rankUiElements(candidates: UiElementCandidate[], query: string, limit = DEFAULT_LIMIT): UiElementCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreUiElement(candidate, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.text.length - b.candidate.text.length || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * AIA가 넘긴 단서로 후보를 되찾는다. ref가 살아 있으면 그것, 아니면 텍스트가 정확히 같은 것,
 * 그것도 없으면 텍스트를 query로 삼아 충분히 맞는 첫 후보.
 */
export function matchUiElementLocator(candidates: UiElementCandidate[], locator: UiElementLocator): UiElementCandidate | null {
  if (locator.ref) {
    const byRef = candidates.find((candidate) => candidate.ref === locator.ref);
    if (byRef) return byRef;
  }
  const text = locator.text?.trim().toLowerCase();
  if (!text) return null;
  const roleMatches = (candidate: UiElementCandidate) => !locator.role || candidate.role === locator.role;
  const exact = candidates.find((candidate) => roleMatches(candidate) && candidate.text.toLowerCase() === text);
  if (exact) return exact;
  const ranked = rankUiElements(candidates.filter(roleMatches), text, 1);
  return ranked.length > 0 && scoreUiElement(ranked[0], text) >= 3 ? ranked[0] : null;
}

/**
 * 속성 값을 그대로 넣는 CSS 속성 선택자. 값에 든 따옴표·역슬래시만 이스케이프한다 —
 * `data-ui-ref`·`data-ui-anchor`는 우리가 붙이거나 JSON으로 검증한 값이라 그 밖의
 * 문자는 선택자를 깨뜨리지 않는다.
 */
export function attributeSelector(attribute: string, value: string): string {
  return `[${attribute}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

export function uiRefSelector(ref: string): string {
  return attributeSelector("data-ui-ref", ref);
}

// ---- 여기부터 DOM ----

function uiElementRole(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "input") {
    const type = (element as HTMLInputElement).type;
    if (type === "checkbox" || type === "radio") return type;
    if (type === "button" || type === "submit" || type === "reset") return "button";
    return "textbox";
  }
  if (tag === "textarea" || element.getAttribute("contenteditable") === "true") return "textbox";
  if (tag === "select") return "select";
  if (tag === "a") return "link";
  return "button";
}

function uiElementText(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria?.trim()) return normalizeUiText(aria);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    const label = Array.from(element.labels ?? []).map((item) => item.textContent ?? "").join(" ").trim();
    if (label) return normalizeUiText(label);
    const placeholder = element.getAttribute("placeholder");
    if (placeholder?.trim()) return normalizeUiText(placeholder);
  }
  const text = (element as HTMLElement).innerText ?? element.textContent ?? "";
  if (text.trim()) return normalizeUiText(text);
  const title = element.getAttribute("title");
  return title?.trim() ? normalizeUiText(title) : "";
}

/**
 * 화면에 자리를 차지하는지. 비활성 화면은 언마운트가 아니라 `hidden`으로 숨겨지므로
 * DOM에 있는 것만으로는 부족하고 실제 크기를 봐야 한다(화면 안내 대기와 같은 판정).
 */
export function isElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

let refCounter = 0;
function nextUiRef(): string {
  refCounter += 1;
  return `ui-${Date.now().toString(36)}-${refCounter}`;
}

/**
 * 지금 보이는 조작 요소를 요약한다. AIA 팝업과 안내 포인터 자체는 대상이 아니다. 요소에
 * `data-ui-ref`가 없으면 붙여 두어 AIA가 같은 요소를 되찾을 수 있게 한다.
 */
export function collectVisibleUiElements(root: ParentNode = document): UiElementCandidate[] {
  const candidates: UiElementCandidate[] = [];
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
    candidates.push({ ref, role: uiElementRole(element), text, anchor: element.getAttribute("data-ui-anchor") });
  }
  return candidates;
}

/**
 * 아이아 커서가 승인 없이 눌러도 되는 "여는 동작"인지. 탭·주 메뉴·등록 대상, 펼침 상태를 가진
 * 버튼(aria-expanded/haspopup/controls), details의 summary가 여기 든다. 화면을 바꾸기만 하고
 * 되돌릴 수 있는 조작이라는 뜻이다.
 */
export function isUiOpener(element: Element): boolean {
  if (element.hasAttribute("data-ui-anchor")) return true;
  if (element.getAttribute("role") === "tab") return true;
  if (element.hasAttribute("aria-expanded") || element.hasAttribute("aria-haspopup") || element.hasAttribute("aria-controls")) return true;
  if (element.tagName.toLowerCase() === "summary") return true;
  return Boolean(element.closest("nav"));
}

export type UiClickMode = "open" | "click";

/** 누르면 안 되는 이유. null이면 눌러도 된다. */
export function uiClickRefusal(element: Element, mode: UiClickMode): string | null {
  if (element.closest(".modal-backdrop")) return "확인 모달 안의 버튼은 아이아가 누르지 않습니다. 사용자가 직접 결정해야 합니다";
  if (element.closest(".aia-chat-popup")) return "AIA 팝업 안의 요소는 누르지 않습니다";
  if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") return "비활성화된 요소입니다";
  if (mode === "open" && !isUiOpener(element)) {
    return "화면을 여는 동작이 아닌 버튼입니다. 사용자가 이 조작을 요청했다면 click_ui_element(승인)를 쓰세요";
  }
  return null;
}

/** 요소를 실제로 조작한다. 입력은 클릭 대신 포커스를 준다. */
export function activateUiElement(element: Element): void {
  const target = element as HTMLElement;
  const role = uiElementRole(element);
  if (role === "textbox" || role === "select") {
    target.focus();
    return;
  }
  target.focus();
  target.click();
}

/** AIA가 넘긴 단서로 화면의 요소를 되찾는다. ref가 살아 있고 보이면 그대로, 아니면 텍스트로 재탐색. */
export function locateUiElement(locator: UiElementLocator, root: ParentNode = document): Element | null {
  if (locator.ref) {
    const direct = root.querySelector(uiRefSelector(locator.ref));
    if (direct && isElementVisible(direct)) return direct;
  }
  const match = matchUiElementLocator(collectVisibleUiElements(root), locator);
  return match ? root.querySelector(uiRefSelector(match.ref)) : null;
}
