import assert from "node:assert/strict";
import test from "node:test";
import { optimisticSessionMeta } from "./sessionMeta.ts";

const base = {
  favorite: false,
  hidden: false,
  note: null,
  customTitle: null,
  folderIds: [],
  reasoningEffort: null,
  mode: null,
  approvalMode: null,
  creationAccountId: null,
  boundAccountId: null,
  pinnedAccountId: null,
};

test("an absent field is left alone and the source object is not mutated", () => {
  const current = { ...base, favorite: true, note: "메모", folderIds: ["f1"] };
  const next = optimisticSessionMeta(current, { hidden: true });
  assert.equal(next.favorite, true);
  assert.equal(next.note, "메모");
  assert.deepEqual(next.folderIds, ["f1"]);
  assert.equal(next.hidden, true);
  assert.equal(current.hidden, false);
});

test("text fields are trimmed and blank values clear them", () => {
  const next = optimisticSessionMeta(base, { note: "  적어둠  ", customTitle: "   " });
  assert.equal(next.note, "적어둠");
  assert.equal(next.customTitle, null);
  assert.equal(optimisticSessionMeta(base, { note: null }).note, null);
});

test("folder ids drop duplicates while keeping order", () => {
  const next = optimisticSessionMeta(base, { folderIds: ["b", "a", "b"] });
  assert.deepEqual(next.folderIds, ["b", "a"]);
});

test("bookmarks are left to the save round trip instead of being applied optimistically", () => {
  const current = { ...base, bookmarks: [] };
  const next = optimisticSessionMeta(current, { bookmarks: [{ id: "b1" }], favorite: true });
  assert.deepEqual(next.bookmarks, []);
  assert.equal(next.favorite, true);
});

test("pinning an account trims the id and an empty value releases the pin", () => {
  assert.equal(optimisticSessionMeta(base, { pinnedAccountId: " acc-1 " }).pinnedAccountId, "acc-1");
  const pinned = { ...base, pinnedAccountId: "acc-1" };
  assert.equal(optimisticSessionMeta(pinned, { pinnedAccountId: null }).pinnedAccountId, null);
  assert.equal(optimisticSessionMeta(pinned, { pinnedAccountId: "" }).pinnedAccountId, null);
});

// 백엔드 `clean_optional`은 `chars().take(20_000)`으로 자른다. 낙관 갱신이 `slice`
// (UTF-16 코드 단위)로 자르면 서버가 저장할 값보다 일찍 자르고, 경계에서 서로게이트 쌍을
// 갈라 반쪽 글자를 화면에 올린다.
test("세션 메모 낙관 갱신은 백엔드와 같은 코드 포인트 단위로 자른다", () => {
  const note = "\u{1F600}".repeat(15_000);
  const applied = optimisticSessionMeta(base, { note });
  assert.equal([...applied.note].length, 15_000);
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(applied.note),
    false,
  );
});
