import assert from "node:assert/strict";
import test from "node:test";

import {
  accountTextDraftState,
  accountTextLength,
  submitAccountText,
} from "./accountTextDraft.ts";

const trimNormalize = (draft) => (draft.trim() === "" ? null : draft.trim());

test("빈 초안은 값 비우기로 정리되고 저장돼 있던 값이 있을 때만 clears가 선다", () => {
  assert.equal(accountTextDraftState("  ", null, trimNormalize, 10).clears, false);
  assert.equal(accountTextDraftState("  ", "옛값", trimNormalize, 10).clears, true);
});

test("값이 그대로면 저장하지 않고 상한을 넘으면 막는다", () => {
  const same = accountTextDraftState("같음", "같음", trimNormalize, 10);
  assert.equal(same.changed, false);
  assert.equal(same.canSave, false);

  const long = accountTextDraftState("abcdef", null, trimNormalize, 5);
  assert.equal(long.tooLong, true);
  assert.equal(long.canSave, false);
});

test("길이는 서로게이트 쌍을 한 글자로 센다", () => {
  assert.equal(accountTextLength(" 🙂🙂 ", trimNormalize), 2);
});

test("저장할 것이 없으면 요청을 보내지 않는다", async () => {
  const calls = [];
  const result = await submitAccountText("같음", "같음", async (value) => {
    calls.push(value);
    return null;
  }, trimNormalize, 10);
  assert.deepEqual(result, { requested: false, close: false, error: null });
  assert.deepEqual(calls, []);
});

test("저장에 실패하면 편집기를 닫지 않는다", async () => {
  const ok = await submitAccountText("새값", null, async () => null, trimNormalize, 10);
  assert.deepEqual(ok, { requested: true, close: true, error: null });

  const failed = await submitAccountText("새값", null, async () => "실패", trimNormalize, 10);
  assert.deepEqual(failed, { requested: true, close: false, error: "실패" });
});
