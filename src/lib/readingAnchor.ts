/**
 * 긴 답변 안의 "읽던 자리"를 가리키는 규칙 한 벌.
 *
 * 답변 하나가 화면 몇 개 분량이면, 다 읽기 전에 다음 질문을 보내는 일이 생긴다. 그때
 * 화면은 새 요청 자리로 옮겨 가고(`scrollToLastUserMessage`), 읽다 만 자리로 돌아갈
 * 방법이 남지 않는다. 그 자리를 적어 두고 되찾는 일을 여기 모은다.
 *
 * 자리를 스크롤 픽셀로 적지 않는 것이 이 파일의 핵심이다. 픽셀은 창 폭이 바뀌는 순간
 * 다른 곳을 가리키고, 같은 대화를 라이브 채팅이 아니라 세션 원문으로 다시 열면 앞에
 * 붙는 분량이 달라 아예 무의미해진다. 대신 "어느 메시지의 어느 마크다운 원문 줄"로
 * 적는다 — `MarkdownPreview`가 블록마다 이미 들고 있는 값이라 새로 계산할 것이 없고,
 * 본문이 같으면 어느 화면에서 그리든 같은 줄 번호가 나온다.
 *
 * 대화 화면·세션 상세·AIA 팝업이 같은 앵커를 쓴다. 규칙을 세 벌로 두면 한쪽에서 남긴
 * 자리를 다른 쪽이 못 찾는 식으로 조용히 갈라진다.
 *
 * 표시해 둔 자리 목록을 고치는 규칙(더하기·이름 고치기·빼기·상한)은
 * `sessionBookmarks.ts`가 맡는다. 화면 하나가 두 무리를 섞어 이 이름으로 가져다 쓰고
 * 있으므로, 목록 쪽 API는 여기서 다시 내보낸다 — 다만 그 화면이 실제로 이 이름으로
 * 가져다 쓰는 것만 내보낸다. 상한값 자체는 화면이 묻지 않고 `bookmarksFull`로 판정을
 * 받아 가므로 여기 창구에 두지 않는다.
 */

import type { ReadingAnchor } from "../types";

export {
  addBookmark,
  bookmarkAnchor,
  bookmarkTitle,
  bookmarksFull,
  removeBookmark,
  renameBookmark,
} from "./sessionBookmarks.ts";

/**
 * 찾을 자리 한 벌. 앵커에 본문 앞머리를 곁들인 모양이다 — 저장된 책갈피는 스니펫을
 * 따로 들고 있고(`SessionBookmark.snippet`), 자동으로 챙긴 자리는 앵커와 함께 들고
 * 다닌다. 세 번째 규칙(본문 대조)이 두 갈래 모두에 닿게 한 이름으로 받는다.
 *
 * 밖으로 내보내지 않는다. 앵커를 넘기는 자리는 모두 객체를 그 자리에서 엮어 넘기므로
 * 이 이름을 부를 일이 없고, 내보내 두면 화면이 이 이름으로 값을 들고 다니기 시작해
 * 스니펫을 함께 싣는 규칙이 모듈 밖으로 새어 나간다.
 */
type AnchorQuery = ReadingAnchor & { snippet?: string };

/** 화면이 앵커 후보로 내놓는 요소 하나. DOM을 모르는 선택 규칙이 보는 값이다. */
export interface AnchorCandidate {
  messageKey: string;
  markdownLine: number | null;
  /** 블록 앞머리. 메시지 열쇠가 달라진 뒤 같은 자리를 되찾는 마지막 단서다. */
  snippet: string;
}

/** 스니펫으로 같은 자리를 찾을 때 비교하는 길이. 짧으면 흔한 문장이 겹치고, 길면 사소한 차이에 놓친다. */
const SNIPPET_MATCH_CHARS = 40;
/**
 * 저장하는 스니펫 길이. 백엔드 상한(200자)보다 짧게 잡아 잘릴 일이 없게 한다.
 * 화면은 길이를 정하지 않고 `anchorSnippet`에 글자만 넘기므로 여기 안에서만 쓰인다.
 */
const BOOKMARK_SNIPPET_CHARS = 120;
/** 되돌아갈 버튼을 접는 거리. 이만큼 안으로 들어왔으면 이미 그 자리를 보고 있는 것으로 읽는다. */
const RETURN_BUTTON_NEAR_PX = 200;

/** 라이브 채팅 메시지의 열쇠. `chatEntryKey`와 같은 값으로 메시지를 식별한다. */
export function liveMessageKey(entryId: string, kind: string): string {
  return `live:${entryId}:${kind}`;
}

/** 세션 원문 항목의 열쇠. 원본 파일의 바이트 오프셋은 추가 전용 파일에서 변하지 않는다. */
export function transcriptMessageKey(index: number): string {
  return `item:${index}`;
}

/** 화면 글자를 앵커에 담을 만큼 줄인다. 줄바꿈·연속 공백은 한 칸으로 모은다. */
export function anchorSnippet(text: string, limit = BOOKMARK_SNIPPET_CHARS): string {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * 후보 가운데 앵커가 가리키는 자리를 고른다. 위에서부터 먼저 맞는 규칙이 이긴다.
 *
 *  1. 같은 메시지의 같은 줄 — 같은 화면에서 되돌아오는 보통의 경우.
 *  2. 같은 메시지에서 가장 가까운 줄 — 그 사이 본문이 조금 달라졌거나(스트리밍이 끝나며
 *     자란 답변) 블록 나눔이 달라진 경우.
 *  3. 다른 메시지라도 같은 글로 시작하는 블록 — 라이브 채팅에서 남긴 자리를 나중에 세션
 *     원문에서 여는 경우다. 열쇠(`live:` vs `item:`)는 달라지지만 본문은 같은 글이다.
 *
 * 못 찾으면 -1. 호출부는 그때 "그 자리를 더 찾을 수 없습니다"를 알린다 — 엉뚱한 곳으로
 * 옮겨 놓고 찾았다고 하는 것보다 낫다.
 *
 * 세 규칙이 루프 하나와 그 안의 이른 반환으로 엉켜 있었다. 첫 규칙은 후보를 모으는 루프
 * 한가운데에서 반환하고, 둘째 규칙은 그 루프가 끝난 자리에서 다시 최솟값을 손으로 훑어,
 * 위 목록의 몇 번째 규칙을 읽고 있는지가 코드 모양으로는 드러나지 않았다. 규칙마다 이름을
 * 주면 이 함수에 남는 것은 "먼저 맞는 규칙이 이긴다"는 순서뿐이다.
 */
export function pickAnchorCandidate(candidates: AnchorCandidate[], anchor: AnchorQuery): number {
  const sameMessage = sameMessageIndexes(candidates, anchor.messageKey);
  const exact = exactLineIndex(candidates, sameMessage, anchor.markdownLine);
  if (exact >= 0) return exact;
  if (sameMessage.length > 0) return nearestLineIndex(candidates, sameMessage, anchor.markdownLine);
  return matchBySnippet(candidates, anchor);
}

/** 앵커와 같은 메시지에 속한 후보의 자리. 목록에 나온 순서를 그대로 지킨다. */
function sameMessageIndexes(candidates: AnchorCandidate[], messageKey: string): number[] {
  const indexes: number[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.messageKey === messageKey) indexes.push(index);
  }
  return indexes;
}

/**
 * 규칙 1 — 줄 번호까지 같은 첫 후보. 없으면 -1.
 *
 * 줄 번호를 모르는 후보는 여기서 맞지 않는다. 양쪽이 모두 `null`이라고 같은 자리라고 할
 * 수는 없어서다 — 마크다운이 아닌 메시지는 블록마다 줄 번호가 없으므로, 그렇게 보면 그
 * 메시지의 아무 블록이나 "정확히 같은 줄"이 된다.
 */
function exactLineIndex(
  candidates: AnchorCandidate[],
  sameMessage: readonly number[],
  markdownLine: number | null,
): number {
  if (markdownLine === null) return -1;
  const found = sameMessage.find((index) => {
    const line = candidates[index].markdownLine;
    return line !== null && line === markdownLine;
  });
  return found ?? -1;
}

/**
 * 규칙 2 — 같은 메시지 안에서 줄 번호가 가장 가까운 후보. 동률이면 앞선 후보가 이긴다.
 * 줄 번호를 모르는 앵커(마크다운이 아닌 메시지)는 그 메시지의 첫 후보로 간다.
 */
function nearestLineIndex(
  candidates: AnchorCandidate[],
  sameMessage: readonly number[],
  markdownLine: number | null,
): number {
  if (markdownLine === null) return sameMessage[0];
  let nearest = sameMessage[0];
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const index of sameMessage) {
    const line = candidates[index].markdownLine;
    const distance = line === null ? Number.POSITIVE_INFINITY : Math.abs(line - markdownLine);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * 메시지 열쇠가 더 이상 맞지 않을 때 본문 글로 찾는다. 앵커에 스니펫이 없거나 너무 짧으면
 * 시도하지 않는다 — 짧은 글로 찾으면 다른 문단을 같은 자리라고 우기게 된다.
 */
function matchBySnippet(candidates: AnchorCandidate[], anchor: AnchorQuery): number {
  const wanted = anchorSnippet(anchor.snippet ?? "", SNIPPET_MATCH_CHARS);
  if (wanted.length < SNIPPET_MATCH_CHARS) return -1;
  return candidates.findIndex((candidate) => anchorSnippet(candidate.snippet, SNIPPET_MATCH_CHARS) === wanted);
}

/**
 * 읽던 자리로 되돌아갈 버튼을 아직 보여줘야 하는가. 사용자가 스스로 그 근처까지 돌아왔으면
 * 버튼은 할 일이 없다 — 남겨 두면 이미 보고 있는 자리로 다시 가는 버튼이 된다.
 */
export function readingPointStillUseful(currentScrollTop: number, pointScrollTop: number): boolean {
  return Math.abs(currentScrollTop - pointScrollTop) > RETURN_BUTTON_NEAR_PX;
}
