/**
 * '읽던 자리'를 **DOM에서** 짚는 쪽. 어느 요소를 앵커로 볼지, 화면 어디까지를 "보고
 * 있는 자리"로 칠지, 되돌아갈 때 어떻게 세울지가 여기 모여 있다.
 *
 * 자리를 어떻게 적고 어느 후보가 그 자리인지 고르는 규칙은 `lib/readingAnchor.ts`에,
 * 버튼과 목록은 `ReadingBookmarks.tsx`에 있다. 셋은 바뀌는 이유가 다르다 — 화면 구조가
 * 바뀌면 이 파일만, 앵커를 적는 규칙이 바뀌면 lib만, 버튼이 바뀌면 컴포넌트만 움직인다.
 * 한 파일에 섞어 두면 마크업 셀렉터를 고치려 해도 훅과 버튼을 함께 읽어야 했다.
 */
import { anchorSnippet, pickAnchorCandidate, type AnchorCandidate } from "../lib/readingAnchor";
import type { ReadingAnchor } from "../types";

/**
 * 블록이 이만큼은 보여야 "읽고 있는 자리"로 친다. 화면 맨 위 경계에 끝자락만 걸친
 * 블록은 이미 지나간 글이라, 그것을 잡으면 표시한 자리가 보고 있던 글보다 위가 된다.
 */
const VISIBLE_ENOUGH_PX = 24;
/** 되돌아간 자리를 강조하는 시간. 눈이 따라갈 만큼만 남기고 지운다. */
const HIGHLIGHT_MS = 1600;
/** 옮겨 간 자리 위에 두는 여백. `scrollToLastUserMessage`와 같은 값이다. */
const ANCHOR_TOP_MARGIN_PX = 12;

/** 자리를 적어 둘 때 본문 대조용 글까지 함께 들고 다니는 앵커. */
export type AnchorWithSnippet = ReadingAnchor & { snippet: string };

/**
 * 앵커로 삼을 수 있는 요소들. 메시지 카드와 그 안의 마크다운 블록이다. 문서 순서로
 * 나오므로 위에서 아래 순서가 그대로 화면 순서다.
 */
function anchorElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-message-key], [data-md-line]"));
}

function anchorCandidate(element: HTMLElement): AnchorCandidate | null {
  const messageKey = element.closest<HTMLElement>("[data-message-key]")?.dataset.messageKey;
  if (!messageKey) return null;
  const line = element.dataset.mdLine;
  return {
    messageKey,
    markdownLine: line === undefined ? null : Number(line),
    snippet: anchorSnippet(element.textContent ?? ""),
  };
}

/**
 * 지금 화면에서 읽고 있는 자리를 앵커로 적는다. 사용자가 따로 무엇을 고르지 않아도
 * 되도록 "보고 있던 자리"를 화면 상태에서 그대로 읽는다.
 *
 * 화면 맨 위 경계를 지나간 블록이 아니라 **눈에 보이는 첫 블록**을 잡는다. 경계에
 * 걸친 블록은 이미 읽은 글이라, 그것을 표시하면 보고 있던 글보다 한 문단 위가 표시된다.
 */
export function captureReadingAnchor(container: HTMLElement): AnchorWithSnippet | null {
  const containerTop = container.getBoundingClientRect().top;
  const elements = anchorElements(container);
  const visible = firstVisibleFrom(elements, containerTop);
  // 메시지 카드가 먼저 걸리면 그 안에서 보이는 첫 블록까지 좁힌다. 카드째로 적으면
  // 답변 중간을 표시해도 답변 첫 줄로 돌아간다.
  const element = visible?.dataset.mdLine === undefined && visible
    ? firstVisibleFrom(Array.from(visible.querySelectorAll<HTMLElement>("[data-md-line]")), containerTop) ?? visible
    : visible ?? elements[0];
  if (!element) return null;
  const candidate = anchorCandidate(element);
  if (!candidate) return null;
  return {
    messageKey: candidate.messageKey,
    markdownLine: candidate.markdownLine,
    snippet: candidate.snippet,
  };
}

/** 화면에 충분히 보이는 첫 요소. 문서 순서가 곧 화면 순서라 앞에서부터 본다. */
function firstVisibleFrom(elements: HTMLElement[], containerTop: number): HTMLElement | null {
  return elements.find((element) => (
    element.getBoundingClientRect().bottom > containerTop + VISIBLE_ENOUGH_PX
  )) ?? null;
}

/** 앵커가 가리키는 자리로 옮기고 잠깐 강조한다. 가리킬 자리를 못 찾으면 false. */
export function scrollToReadingAnchor(container: HTMLElement, anchor: AnchorWithSnippet): boolean {
  const elements: HTMLElement[] = [];
  const candidates: AnchorCandidate[] = [];
  for (const element of anchorElements(container)) {
    const candidate = anchorCandidate(element);
    if (!candidate) continue;
    elements.push(element);
    candidates.push(candidate);
  }
  const index = pickAnchorCandidate(candidates, anchor);
  if (index < 0) return false;

  const element = elements[index];
  const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 표시한 자리가 화면 맨 위에 오도록 세운다. 한때는 표시할 때 그 블록이 위로 잘려
  // 있던 만큼까지 되살렸는데, 그러면 블록 첫 줄이 화면 밖으로 밀려 표시한 자리가
  // 아니라 그 아래 글부터 보인다. 마지막 사용자 메시지로 옮길 때와 같은 여백을 둔다.
  container.scrollTo({ top: Math.max(0, top - ANCHOR_TOP_MARGIN_PX), behavior: reduceMotion ? "auto" : "smooth" });
  highlight(element);
  return true;
}

/** 옮겨 간 자리를 잠깐 표시한다. 글이 빽빽한 답변에서는 어디에 섰는지 보이지 않는다. */
function highlight(element: HTMLElement): void {
  element.classList.add("is-reading-target");
  window.setTimeout(() => element.classList.remove("is-reading-target"), HIGHLIGHT_MS);
}
