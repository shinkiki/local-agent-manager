import { textCharacters } from "./boundedText.ts";
import { attributeSelector } from "./uiElementDom.ts";
import type { UiElementLocator } from "../types";

/**
 * AIA 화면 안내에서 DOM을 만지지 않는 절반 — 요소 요약 하나가 query와 얼마나 맞는지 재고,
 * AIA가 넘긴 단서로 그 요약을 되찾는 일.
 *
 * 스캔·표출 쪽(`uiElements`)과는 서로 읽을 것이 없다. 저쪽은 지금 화면의 요소를 훑어
 * 요약으로 바꾸고 실제로 누르는 일이라 `document`·`HTMLElement`가 있어야 돌고, 여기는
 * 이미 만들어진 요약 배열과 문자열만 보는 순수 함수다. 한 파일에 두면 점수 규칙 한 줄을
 * 고치러 들어온 사람이 폼 컨트롤 이름 읽기와 승인 카드 금지 표를 함께 읽게 되고, 반대로
 * DOM 판정을 고치러 온 사람은 이 점수표를 지나쳐야 한다.
 */

export interface UiElementCandidate {
  /** 스캔 때 요소에 붙인 `data-ui-ref`. 요소가 다시 그려지면 사라질 수 있다. */
  ref: string;
  role: string;
  text: string;
  /** 등록 대상 앵커가 있으면 함께 알려 AIA가 안정적인 target을 고를 수 있게 한다. */
  anchor: string | null;
}

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

/**
 * 화면 요소 하나의 글자를 스캔 결과에 실을 모양으로 줄인다.
 *
 * 자르기는 코드 포인트 단위다. `slice`(UTF-16 코드 단위)로 자르면 경계가 서로게이트 쌍
 * 한가운데에 놓일 때 반쪽만 남은 글자가 스캔 응답에 실린다 — 이 응답은 `find_ui_elements`로
 * 백엔드를 거쳐 AIA에게 가므로, 화면 이름에 이모지를 쓴 세션·프로젝트 하나 때문에 스캔
 * 전체가 읽히지 않게 될 수 있다.
 */
export function normalizeUiText(text: string): string {
  const collapsed = textCharacters(text.replace(/\s+/g, " ").trim());
  return collapsed.length > MAX_TEXT_CHARS
    ? `${collapsed.slice(0, MAX_TEXT_CHARS - 1).join("")}…`
    : collapsed.join("");
}

const TOKEN_TO_ROLE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(ROLE_WORDS).flatMap(([role, words]) => words.map((word) => [word, role])),
);

function roleForToken(token: string): string | null {
  return TOKEN_TO_ROLE[token] ?? null;
}

function parseQueryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function scoreUiElementTokens(
  candidate: Pick<UiElementCandidate, "text" | "role">,
  tokens: readonly string[],
): number {
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

/** query 토큰이 텍스트·역할과 얼마나 맞는지. 0이면 후보가 아니다. 빈 query는 모두 1점. */
export function scoreUiElement(candidate: Pick<UiElementCandidate, "text" | "role">, query: string): number {
  return scoreUiElementTokens(candidate, parseQueryTokens(query));
}

interface ScoredUiElement {
  candidate: UiElementCandidate;
  index: number;
  score: number;
}

/** 점수가 1점 이상인 후보를 점수 내림차순, 텍스트 길이 오름차순, 원본 순서로 정렬한다. */
function scoredUiElements(candidates: UiElementCandidate[], query: string): ScoredUiElement[] {
  const tokens = parseQueryTokens(query);
  return candidates
    .map((candidate, index) => ({ candidate, index, score: scoreUiElementTokens(candidate, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.text.length - b.candidate.text.length || a.index - b.index);
}

export function rankUiElements(candidates: UiElementCandidate[], query: string, limit = DEFAULT_LIMIT): UiElementCandidate[] {
  return scoredUiElements(candidates, query)
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
  const scored = scoredUiElements(candidates.filter(roleMatches), text);
  return scored.length > 0 && scored[0].score >= 3 ? scored[0].candidate : null;
}

/** 스캔이 붙인 `data-ui-ref`로 요소를 지목하는 선택자. */
export function uiRefSelector(ref: string): string {
  return attributeSelector("data-ui-ref", ref);
}
