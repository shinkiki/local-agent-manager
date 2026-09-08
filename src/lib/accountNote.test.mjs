import assert from "node:assert/strict";
import test from "node:test";

import {
  accountNoteDraftState,
  accountNoteLength,
  ACCOUNT_NOTE_MAX_CHARS,
  normalizeAccountNote,
  submitAccountNote,
} from "./accountNote.ts";

function recordingSave(error = null) {
  const calls = [];
  return {
    calls,
    save: async (note) => {
      calls.push(note);
      return error;
    },
  };
}

test("a note draft is trimmed and line endings are normalized before saving", () => {
  assert.equal(normalizeAccountNote("  결제 담당 계정  "), "결제 담당 계정");
  assert.equal(normalizeAccountNote("첫 줄\r\n둘째 줄"), "첫 줄\n둘째 줄");
  assert.equal(normalizeAccountNote("변경 없음"), "변경 없음");
});

test("an empty draft means deleting the stored note", () => {
  for (const draft of ["", "   ", "\n\n", "\r\n"]) {
    assert.equal(normalizeAccountNote(draft), null, JSON.stringify(draft));
  }

  const state = accountNoteDraftState("   ", "기존 메모");
  assert.equal(state.value, null);
  assert.equal(state.removes, true);
  assert.equal(state.canSave, true);
});

test("an unchanged draft cannot be saved so no request is sent", () => {
  assert.equal(accountNoteDraftState("기존 메모", "기존 메모").canSave, false);
  // 공백만 다른 입력은 정규화 후 같은 값이라 변경으로 보지 않는다.
  assert.equal(accountNoteDraftState("  기존 메모  ", "기존 메모").canSave, false);
  assert.equal(accountNoteDraftState("", null).canSave, false);
  assert.equal(accountNoteDraftState("새 메모", null).canSave, true);
});

test("an over-length note is blocked before the request with the current length reported", () => {
  const longest = "가".repeat(ACCOUNT_NOTE_MAX_CHARS);
  const atLimit = accountNoteDraftState(longest, null);
  assert.equal(atLimit.length, ACCOUNT_NOTE_MAX_CHARS);
  assert.equal(atLimit.tooLong, false);
  assert.equal(atLimit.canSave, true);

  const overLimit = accountNoteDraftState(`${longest}가`, null);
  assert.equal(overLimit.length, ACCOUNT_NOTE_MAX_CHARS + 1);
  assert.equal(overLimit.tooLong, true);
  assert.equal(overLimit.canSave, false);
});

test("saving sends the normalized value and closes the dialog", async () => {
  const { calls, save } = recordingSave();
  const result = await submitAccountNote("  결제 담당\r\n계정  ", null, save);

  assert.deepEqual(calls, ["결제 담당\n계정"]);
  assert.deepEqual(result, { requested: true, close: true, error: null });
});

test("clearing the field sends a deletion request", async () => {
  const { calls, save } = recordingSave();
  const result = await submitAccountNote("   ", "기존 메모", save);

  assert.deepEqual(calls, [null]);
  assert.equal(result.close, true);
});

test("a failed save keeps the dialog open and reports the reason inside it", async () => {
  const { calls, save } = recordingSave("계정 메모는 500자까지 저장할 수 있습니다");
  const result = await submitAccountNote("새 메모", null, save);

  assert.deepEqual(calls, ["새 메모"]);
  assert.deepEqual(result, {
    requested: true,
    close: false,
    error: "계정 메모는 500자까지 저장할 수 있습니다",
  });
});

test("an unchanged or over-length draft never reaches the backend", async () => {
  const unchanged = recordingSave();
  assert.deepEqual(await submitAccountNote("기존 메모", "기존 메모", unchanged.save), { requested: false, close: false, error: null });
  assert.deepEqual(unchanged.calls, []);

  const overLimit = recordingSave();
  const tooLong = "가".repeat(ACCOUNT_NOTE_MAX_CHARS + 1);
  assert.deepEqual(await submitAccountNote(tooLong, null, overLimit.save), { requested: false, close: false, error: null });
  assert.deepEqual(overLimit.calls, []);
});

test("the length matches the Rust character count for surrogate pairs", () => {
  // 이모지 하나는 Rust의 chars().count()와 같이 한 글자로 센다.
  assert.equal(accountNoteLength("🙂"), 1);
  assert.equal(accountNoteLength("  🙂🙂  "), 2);
  assert.equal(accountNoteLength("가나다"), 3);
});
