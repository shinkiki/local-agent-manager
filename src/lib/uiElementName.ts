import { normalizeUiText } from "./uiElementMatch.ts";

/**
 * 요소 하나를 **무엇이라고 부를지** 정하는 규칙 — 역할 이름과 표시 이름.
 *
 * 스캔(`uiElements`)과 클릭 정책(`uiElementClick`)이 둘 다 이 답을 필요로 하지만, 둘 중
 * 어느 쪽의 사정도 여기에는 없다. 여기가 보는 것은 요소 하나의 속성뿐이고, 화면을 훑는
 * 순서도 누를 수 있는지도 모른다. 한 파일에 함께 두면 `aria-label` 우선순위를 고치러 온
 * 사람이 승인 카드 금지 표와 스캔 선택자를 지나쳐야 하고, 반대로 스캔을 고치러 온 사람은
 * 폼 컨트롤 라벨 읽기를 함께 읽게 된다.
 */

function inputRole(type: string): string {
  if (type === "checkbox" || type === "radio") return type;
  if (type === "button" || type === "submit" || type === "reset") return "button";
  return "textbox";
}

export function uiElementRole(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "input") return inputRole((element as HTMLInputElement).type);
  if (tag === "textarea" || element.getAttribute("contenteditable") === "true") return "textbox";
  if (tag === "select") return "select";
  if (tag === "a") return "link";
  return "button";
}

/**
 * 공백뿐인 값은 없는 것으로 본다. 다듬은 값은 판정에만 쓰고 원문을 그대로 돌려준다 —
 * 화면에 올릴 모양을 만드는 일은 `normalizeUiText`의 몫이라 여기서 미리 잘라 두면
 * 출처마다 다듬기가 한 번 더 걸린 문자열과 아닌 문자열이 섞인다.
 */
function nonBlankText(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

/** 폼 컨트롤은 자기 안에 글자가 없다. 붙은 라벨을, 없으면 자리표시자를 이름으로 쓴다. */
function formControlText(element: Element): string | null {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
    return null;
  }
  const label = Array.from(element.labels ?? []).map((item) => item.textContent ?? "").join(" ").trim();
  return nonBlankText(label) ?? nonBlankText(element.getAttribute("placeholder"));
}

/**
 * 요소의 이름을 읽을 출처. 앞에서부터 내용이 있는 첫 출처를 쓴다 — 읽기 보조 기기에
 * 주는 이름(`aria-label`)이 가장 확실하고, 글자가 없는 폼 컨트롤은 붙은 라벨로, 그다음이
 * 눈에 보이는 글자, 마지막이 도움말(`title`)이다.
 *
 * 출처마다 "다듬어서 남는 게 있으면 그 값, 아니면 다음"을 각자 적고 있었다. 네 벌이면
 * 무엇을 비어 있다고 볼지(공백만 있는 라벨·줄바꿈뿐인 본문)가 네 곳에 흩어져, 한쪽만
 * 고쳐도 빌드는 통과하고 같은 요소가 스캔 경로에 따라 다른 이름으로 잡힌다. 순서까지
 * 이 표 한 벌이 소유하면 출처를 끼워 넣을 자리가 한 곳뿐이다.
 */
const UI_ELEMENT_TEXT_SOURCES: readonly ((element: Element) => string | null)[] = [
  (element) => element.getAttribute("aria-label"),
  formControlText,
  (element) => (element as HTMLElement).innerText ?? element.textContent,
  (element) => element.getAttribute("title"),
];

function rawUiElementText(element: Element): string | null {
  for (const source of UI_ELEMENT_TEXT_SOURCES) {
    const text = nonBlankText(source(element));
    if (text) return text;
  }
  return null;
}

/** 요약에 올릴 이름. 읽을 이름이 하나도 없으면 빈 문자열이고, 스캔은 그런 요소를 버린다. */
export function uiElementText(element: Element): string {
  const raw = rawUiElementText(element);
  return raw ? normalizeUiText(raw) : "";
}
