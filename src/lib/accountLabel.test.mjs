import assert from "node:assert/strict";
import test from "node:test";

import {
  accountLabelDraftState,
  accountLabelLength,
  ACCOUNT_LABEL_MAX_CHARS,
  normalizeAccountLabel,
  submitAccountLabel,
} from "./accountLabel.ts";

function recordingSave(error = null) {
  const calls = [];
  return {
    calls,
    save: async (label) => {
      calls.push(label);
      return error;
    },
  };
}

test("a label draft collapses multiple spaces and trims before saving", () => {
  assert.equal(normalizeAccountLabel("  메인   업무 계정  "), "메인 업무 계정");
  assert.equal(normalizeAccountLabel("첫 줄\n둘째 줄"), "첫 줄 둘째 줄");
  assert.equal(normalizeAccountLabel("변경 없음"), "변경 없음");
});

test("an empty draft means resetting the custom label", () => {
  for (const draft of ["", "   ", "\n\n", "\r\n"]) {
    assert.equal(normalizeAccountLabel(draft), null, JSON.stringify(draft));
  }

  const state = accountLabelDraftState("   ", "기존 별칭");
  assert.equal(state.value, null);
  assert.equal(state.restores, true);
  assert.equal(state.canSave, true);
});

test("an unchanged draft cannot be saved so no request is sent", () => {
  assert.equal(accountLabelDraftState("기존 별칭", "기존 별칭").canSave, false);
  // 공백만 다른 입력은 정규화 후 같은 값이라 변경으로 보지 않는다.
  assert.equal(accountLabelDraftState("  기존   별칭  ", "기존 별칭").canSave, false);
  assert.equal(accountLabelDraftState("", null).canSave, false);
  assert.equal(accountLabelDraftState("새 별칭", null).canSave, true);
});

test("an over-length label is blocked before the request with the current length reported", () => {
  const longest = "가".repeat(ACCOUNT_LABEL_MAX_CHARS);
  const atLimit = accountLabelDraftState(longest, null);
  assert.equal(atLimit.length, ACCOUNT_LABEL_MAX_CHARS);
  assert.equal(atLimit.tooLong, false);
  assert.equal(atLimit.canSave, true);

  const overLimit = accountLabelDraftState(`${longest}가`, null);
  assert.equal(overLimit.length, ACCOUNT_LABEL_MAX_CHARS + 1);
  assert.equal(overLimit.tooLong, true);
  assert.equal(overLimit.canSave, false);
});

test("saving sends the normalized value and closes the dialog", async () => {
  const { calls, save } = recordingSave();
  const result = await submitAccountLabel("  개발   팀  ", null, save);

  assert.deepEqual(calls, ["개발 팀"]);
  assert.deepEqual(result, { requested: true, close: true, error: null });
});

test("clearing the field sends a reset request", async () => {
  const { calls, save } = recordingSave();
  const result = await submitAccountLabel("   ", "기존 별칭", save);

  assert.deepEqual(calls, [null]);
  assert.equal(result.close, true);
});

test("a failed save keeps the dialog open and reports the reason inside it", async () => {
  const { calls, save } = recordingSave("계정 표시 이름은 60자까지 저장할 수 있습니다");
  const result = await submitAccountLabel("새 별칭", null, save);

  assert.deepEqual(calls, ["새 별칭"]);
  assert.deepEqual(result, {
    requested: true,
    close: false,
    error: "계정 표시 이름은 60자까지 저장할 수 있습니다",
  });
});

test("an unchanged or over-length draft never reaches the backend", async () => {
  const unchanged = recordingSave();
  assert.deepEqual(await submitAccountLabel("기존 별칭", "기존 별칭", unchanged.save), { requested: false, close: false, error: null });
  assert.deepEqual(unchanged.calls, []);

  const overLimit = recordingSave();
  const tooLong = "가".repeat(ACCOUNT_LABEL_MAX_CHARS + 1);
  assert.deepEqual(await submitAccountLabel(tooLong, null, overLimit.save), { requested: false, close: false, error: null });
  assert.deepEqual(overLimit.calls, []);
});

test("the length matches the Rust character count for surrogate pairs", () => {
  // 이모지 하나는 Rust의 chars().count()와 같이 한 글자로 센다.
  assert.equal(accountLabelLength("🙂"), 1);
  assert.equal(accountLabelLength("  🙂  🙂  "), 3);
  assert.equal(accountLabelLength("가나다"), 3);
  assert.equal(accountLabelLength("   "), 0);
});
