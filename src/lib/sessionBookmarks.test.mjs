import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SESSION_BOOKMARKS,
  addBookmark,
  bookmarkAnchor,
  bookmarkTitle,
  bookmarksFull,
  removeBookmark,
  renameBookmark,
} from "./sessionBookmarks.ts";

function anchor(messageKey, markdownLine, snippet = "") {
  return { messageKey, markdownLine, snippet };
}

function bookmark(id, anchorValue, { label = "", snippet = "" } = {}) {
  return { id, label, snippet, anchor: anchorValue, createdAt: 1 };
}

test("같은 블록을 다시 찍으면 목록이 늘지 않고 자리만 갱신된다", () => {
  const first = bookmark("a", { messageKey: "item:10", markdownLine: 9 }, { label: "결론" });
  const again = bookmark("b", { messageKey: "item:10", markdownLine: 9 }, { snippet: "새 본문" });
  const merged = addBookmark([first], again);
  assert.equal(merged.length, 1);
  // 이름은 사용자가 붙인 값이라 남고, 자리와 본문만 새 값으로 바뀐다.
  assert.equal(merged[0].label, "결론");
  assert.equal(merged[0].snippet, "새 본문");
});

test("다른 줄을 찍으면 새 항목으로 쌓인다", () => {
  const first = bookmark("a", { messageKey: "item:10", markdownLine: 9 });
  const other = bookmark("b", { messageKey: "item:10", markdownLine: 30 });
  assert.equal(addBookmark([first], other).length, 2);
});

test("이름은 앞뒤 공백을 걷어내고 상한까지 자른다", () => {
  const renamed = renameBookmark([bookmark("a", anchor("item:10", 1))], "a", "  읽던 자리  ");
  assert.equal(renamed[0].label, "읽던 자리");
  assert.equal(renameBookmark([bookmark("a", anchor("item:10", 1))], "a", "가".repeat(200))[0].label.length, 120);
});

test("삭제는 그 항목만 뺀다", () => {
  const list = [bookmark("a", anchor("item:1", 1)), bookmark("b", anchor("item:2", 1))];
  assert.deepEqual(removeBookmark(list, "a").map((item) => item.id), ["b"]);
});

test("표시는 이름이 없으면 본문 앞머리를 대신 쓴다", () => {
  assert.equal(bookmarkTitle(bookmark("a", anchor("item:1", 1), { label: "결론" })), "결론");
  assert.equal(bookmarkTitle(bookmark("a", anchor("item:1", 1), { snippet: "본문 앞머리" })), "본문 앞머리");
  assert.equal(bookmarkTitle(bookmark("a", anchor("item:1", 1))), "표시한 자리");
});

test("상한에 닿으면 더 담지 않는다고 알린다", () => {
  const full = Array.from({ length: MAX_SESSION_BOOKMARKS }, (_, index) => bookmark(`id-${index}`, anchor("item:1", index)));
  assert.equal(bookmarksFull(full), true);
  assert.equal(bookmarksFull(full.slice(1)), false);
});

test("책갈피 앵커는 스니펫을 함께 실어 본문 대조까지 닿게 한다", () => {
  const value = bookmarkAnchor(bookmark("a", { messageKey: "item:1", markdownLine: 3 }, { snippet: "본문" }));
  assert.deepEqual(value, { messageKey: "item:1", markdownLine: 3, snippet: "본문" });
});

test("내용 변경이 없거나 대상이 없으면 원본 목록 참조를 그대로 보존한다", () => {
  const item = bookmark("a", anchor("item:10", 1), { label: "기존" });
  const list = [item];

  // 없는 대상 삭제 또는 이름 변경
  assert.equal(removeBookmark(list, "missing"), list);
  assert.equal(renameBookmark(list, "missing", "새이름"), list);

  // 같은 이름으로 변경
  assert.equal(renameBookmark(list, "a", "기존"), list);
  assert.equal(renameBookmark(list, "a", "  기존  "), list);

  // 같은 자리와 스니펫으로 다시 추가
  assert.equal(addBookmark(list, bookmark("dup", anchor("item:10", 1))), list);
});

// 백엔드 `store.rs`는 읽던 자리 이름을 `chars().count()`(코드 포인트)로 120자까지 받는다.
// 화면이 `slice`(UTF-16 코드 단위)로 자르던 동안에는 둘이 갈렸다 — 이모지로만 쓴 100자
// 이름이 한도 안인데도 60자로 잘렸고, 경계가 서로게이트 쌍 한가운데면 반쪽 글자가 그대로
// 저장 요청에 실렸다. 이름 칸에는 maxLength가 없어 붙여넣기 한 번으로 닿는다.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("읽던 자리 이름은 백엔드와 같은 코드 포인트 단위로 자른다", () => {
  const list = [{ id: "a", label: "", snippet: "s", anchor: null, createdAt: 0 }];
  const labelOf = (value) => renameBookmark(list, "a", value)[0].label;

  // 한도(120자) 안이면 이모지만으로 쓴 이름도 한 글자도 잃지 않는다.
  const hundredEmoji = "\u{1F600}".repeat(100);
  assert.equal([...labelOf(hundredEmoji)].length, 100);
  assert.equal(labelOf(hundredEmoji), hundredEmoji);

  // 한도를 넘으면 120 코드 포인트까지만 남는다. UTF-16 단위로 세면 240이 되어 통과한다.
  const overLimit = "\u{1F600}".repeat(200);
  assert.equal([...labelOf(overLimit)].length, 120);

  // 경계가 서로게이트 쌍 한가운데에 놓여도 반쪽 글자를 남기지 않는다.
  const straddling = `a${"\u{1F600}".repeat(200)}`;
  const cut = labelOf(straddling);
  assert.equal([...cut].length, 120);
  assert.equal(LONE_SURROGATE.test(cut), false);
});
