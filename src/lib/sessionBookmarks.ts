import type { ReadingAnchor, SessionBookmark } from "../types";
import { textCharacters } from "./boundedText.ts";

/**
 * 표시해 둔 읽던 자리 목록을 고치는 규칙 — 더하기·이름 고치기·빼기와 상한, 그리고 목록에
 * 무슨 글자를 적을지.
 *
 * 앵커가 가리키는 자리를 화면 후보 중에서 찾아내는 규칙(`readingAnchor.ts`)과 한 파일에
 * 있던 동안에는, 같은 블록을 두 번 찍었을 때 목록이 어떻게 되는지를 보러 들어와도 줄
 * 번호가 어긋났을 때 어느 후보로 가는지까지 함께 스크롤해야 했다. 둘은 바뀌는 이유가
 * 다르다 — 이쪽은 목록에 무엇을 담고 얼마나 담을지가 바뀔 때, 저쪽은 자리를 되찾는
 * 단서가 늘 때 바뀐다.
 *
 * 의존은 한 방향이다. 여기는 후보 고르기를 모르고, 목록을 편집한 결과를 그쪽 규칙이
 * 나중에 찾아 쓴다. 지금 화면들은 둘을 섞어 `readingAnchor.ts` 이름으로 가져다 쓰므로,
 * 여기 API는 그쪽에서 다시 내보낸다.
 */

/** 한 세션이 가질 수 있는 읽던 자리 수. 백엔드 `MAX_SESSION_BOOKMARKS`와 같은 값이다. */
export const MAX_SESSION_BOOKMARKS = 50;

/**
 * 사용자가 붙이는 이름의 길이 상한. 숫자를 `slice` 자리에 그대로 적어 두던 동안에는 같은
 * 120이 스니펫 길이 상한과 우연히 같아, 둘 중 하나를 고치러 온 사람이 나머지 하나까지
 * 같이 움직여야 하는 값인지 식만 보고는 알 수 없었다. 둘은 서로 다른 이유로 정해진
 * 값이다 — 스니펫은 백엔드 상한에 맞춰 잡고, 이름은 목록 한 줄에 들어갈 만큼만 받는다.
 *
 * 세는 단위는 **코드 포인트**다. 백엔드 `store.rs`의 `MAX_BOOKMARK_LABEL_CHARS`가
 * `chars().count()`로 재므로 같은 단위이어야 한다(`boundedText.ts`).
 */
const BOOKMARK_LABEL_CHARS = 120;

/** 목록에 적을 표시. 이름을 붙이지 않았으면 본문 앞머리를 대신 쓴다. */
export function bookmarkTitle(bookmark: SessionBookmark): string {
  const label = bookmark.label.trim();
  if (label) return label;
  const snippet = bookmark.snippet.trim();
  return snippet || "표시한 자리";
}

/**
 * 앵커에 스니펫을 함께 실어 넘기는 자리. `pickAnchorCandidate`는 앵커 하나만 받는데,
 * 스니펫은 책갈피 쪽에 있어 본문 대조 규칙에 닿지 않는다. 호출부마다 객체를 손으로 엮지
 * 않도록 한 벌로 만든다.
 */
export function bookmarkAnchor(bookmark: SessionBookmark): ReadingAnchor & { snippet: string } {
  return { ...bookmark.anchor, snippet: bookmark.snippet };
}

/** 같은 앵커 위치인지. 메시지 열쇠와 마크다운 원문 줄 번호가 모두 같아야 같은 자리다. */
function sameAnchorPosition(left: ReadingAnchor, right: ReadingAnchor): boolean {
  return left.messageKey === right.messageKey && left.markdownLine === right.markdownLine;
}

/**
 * 조건에 맞는 책갈피 하나를 불변 갱신한다. 대상을 찾지 못했거나 변경이 없으면
 * 목록 참조를 그대로 보존한다.
 */
function updateBookmark(
  current: SessionBookmark[],
  predicate: (bookmark: SessionBookmark) => boolean,
  update: (bookmark: SessionBookmark) => SessionBookmark,
): SessionBookmark[] {
  const index = current.findIndex(predicate);
  if (index < 0) return current;
  const target = current[index];
  const updated = update(target);
  if (updated === target) return current;
  const next = [...current];
  next[index] = updated;
  return next;
}

/**
 * 목록에 새 자리를 더한다. 같은 블록을 두 번 찍으면 새로 쌓지 않고 그 자리를 갱신한다 —
 * 스크롤을 조금 움직이며 여러 번 누르면 같은 문단이 목록에 줄줄이 남는다.
 */
export function addBookmark(current: SessionBookmark[], bookmark: SessionBookmark): SessionBookmark[] {
  const existing = current.findIndex((item) => sameAnchorPosition(item.anchor, bookmark.anchor));
  if (existing >= 0) {
    const target = current[existing];
    if (target.snippet === bookmark.snippet && sameAnchorPosition(target.anchor, bookmark.anchor)) {
      return current;
    }
    // 이름은 사용자가 붙인 값이므로 지우지 않는다. 자리만 지금 화면으로 맞춘다.
    const next = [...current];
    next[existing] = { ...target, snippet: bookmark.snippet, anchor: bookmark.anchor };
    return next;
  }
  return [...current, bookmark];
}

/**
 * 이름을 고친 목록. 대상을 찾지 못했거나 이름이 같으면 참조를 그대로 보존한다.
 *
 * 자르기는 코드 포인트 단위다. `slice`(UTF-16 코드 단위)로 자르던 동안에는 두 가지가
 * 함께 어긋났다. 이모지로만 쓴 100자짜리 이름이 백엔드 한도(120자) 안인데도 60자로
 * 잘렸고, 경계가 서로게이트 쌍 한가운데에 놓이면 반쪽만 남은 글자가 그대로 저장 요청에
 * 실렸다. 이름 칸에는 `maxLength`가 없어 붙여넣기 한 번으로 닿는 자리다.
 */
export function renameBookmark(current: SessionBookmark[], id: string, label: string): SessionBookmark[] {
  const trimmed = textCharacters(label.trim()).slice(0, BOOKMARK_LABEL_CHARS).join("");
  return updateBookmark(current, (item) => item.id === id, (item) => (
    item.label === trimmed ? item : { ...item, label: trimmed }
  ));
}

export function removeBookmark(current: SessionBookmark[], id: string): SessionBookmark[] {
  return current.some((item) => item.id === id)
    ? current.filter((item) => item.id !== id)
    : current;
}

/** 상한에 닿았는지. 닿았으면 화면은 버튼을 잠그고 까닭을 적는다. */
export function bookmarksFull(current: SessionBookmark[]): boolean {
  return current.length >= MAX_SESSION_BOOKMARKS;
}
