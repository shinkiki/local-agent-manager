import assert from "node:assert/strict";
import test from "node:test";
import {
  anchorSnippet,
  liveMessageKey,
  pickAnchorCandidate,
  readingPointStillUseful,
  transcriptMessageKey,
} from "./readingAnchor.ts";

function candidate(messageKey, markdownLine, snippet = "") {
  return { messageKey, markdownLine, snippet };
}

function anchor(messageKey, markdownLine, snippet = "") {
  return { messageKey, markdownLine, snippet };
}

test("같은 메시지의 같은 줄이 가장 먼저 잡힌다", () => {
  const candidates = [
    candidate("item:10", 3),
    candidate("item:10", 12),
    candidate("item:20", 12),
  ];
  assert.equal(pickAnchorCandidate(candidates, anchor("item:10", 12)), 1);
});

test("줄이 정확히 없으면 같은 메시지에서 가장 가까운 줄로 간다", () => {
  const candidates = [candidate("item:10", 3), candidate("item:10", 20), candidate("item:10", 40)];
  assert.equal(pickAnchorCandidate(candidates, anchor("item:10", 24)), 1);
});

test("줄 번호가 없는 앵커는 그 메시지의 첫 블록으로 간다", () => {
  const candidates = [candidate("item:5", null), candidate("item:10", 4), candidate("item:10", 9)];
  assert.equal(pickAnchorCandidate(candidates, anchor("item:10", null)), 1);
});

test("라이브에서 남긴 자리는 원문에서 같은 글로 다시 찾는다", () => {
  // 채팅에서 찍은 뒤 같은 대화를 세션 상세에서 열면 메시지 열쇠가 live:에서 item:으로 바뀐다.
  const text = "리프레시 토큰은 회전시키고 만료는 서버가 판단하도록 두는 편이 안전합니다";
  const candidates = [candidate("item:40", 2, "먼저 결론부터 말하면"), candidate("item:40", 9, text)];
  assert.equal(pickAnchorCandidate(candidates, anchor(liveMessageKey("msg-1", "message"), 9, text)), 1);
});

test("짧은 글로는 다른 메시지를 같은 자리라고 우기지 않는다", () => {
  const candidates = [candidate("item:40", 9, "네 맞습니다")];
  assert.equal(pickAnchorCandidate(candidates, anchor("live:msg-1:message", 9, "네 맞습니다")), -1);
});

test("가리킬 자리가 없으면 -1을 돌려준다", () => {
  assert.equal(pickAnchorCandidate([], anchor("item:10", 3)), -1);
  assert.equal(pickAnchorCandidate([candidate("item:99", 1)], anchor("item:10", 3)), -1);
});

test("스니펫은 연속 공백을 모으고 길이를 자른다", () => {
  assert.equal(anchorSnippet("  줄바꿈\n과   공백 "), "줄바꿈 과 공백");
  assert.equal(anchorSnippet("가".repeat(300)).length, 120);
});

test("되돌아갈 자리가 지금 보는 자리면 버튼은 할 일이 없다", () => {
  assert.equal(readingPointStillUseful(1000, 1080), false);
  assert.equal(readingPointStillUseful(1000, 2400), true);
});

test("메시지 열쇠는 화면마다 다른 접두사를 쓴다", () => {
  assert.equal(liveMessageKey("msg-1", "message"), "live:msg-1:message");
  assert.equal(transcriptMessageKey(4096), "item:4096");
});
