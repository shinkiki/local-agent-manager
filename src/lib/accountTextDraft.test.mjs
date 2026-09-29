import assert from "node:assert/strict";
import test from "node:test";

import {
  accountTextDraftState,
  accountTextEditor,
  submitAccountText,
} from "./accountTextDraft.ts";

const trimRules = {
  normalize: (draft) => (draft.trim() === "" ? null : draft.trim()),
  maxChars: 10,
};
const shortRules = { ...trimRules, maxChars: 5 };

test("빈 초안은 값 비우기로 정리되고 저장돼 있던 값이 있을 때만 clears가 선다", () => {
  assert.equal(accountTextDraftState("  ", null, trimRules).clears, false);
  assert.equal(accountTextDraftState("  ", "옛값", trimRules).clears, true);
});

test("값이 그대로면 저장하지 않고 상한을 넘으면 막는다", () => {
  const same = accountTextDraftState("같음", "같음", trimRules);
  assert.equal(same.changed, false);
  assert.equal(same.canSave, false);

  const long = accountTextDraftState("abcdef", null, shortRules);
  assert.equal(long.tooLong, true);
  assert.equal(long.canSave, false);
});

test("길이는 서로게이트 쌍을 한 글자로 센다", () => {
  assert.equal(accountTextDraftState(" 🙂🙂 ", null, trimRules).length, 2);
});

test("저장할 것이 없으면 요청을 보내지 않는다", async () => {
  const calls = [];
  const result = await submitAccountText("같음", "같음", async (value) => {
    calls.push(value);
    return null;
  }, trimRules);
  assert.deepEqual(result, { requested: false, close: false, error: null });
  assert.deepEqual(calls, []);
});

test("저장에 실패하면 편집기를 닫지 않는다", async () => {
  const ok = await submitAccountText("새값", null, async () => null, trimRules);
  assert.deepEqual(ok, { requested: true, close: true, error: null });

  const failed = await submitAccountText("새값", null, async () => "실패", trimRules);
  assert.deepEqual(failed, { requested: true, close: false, error: "실패" });
});

test("규격으로 만든 편집기는 clears를 자기 이름으로 달고 나머지는 그대로 둔다", () => {
  const editor = accountTextEditor({ ...trimRules, clearsAs: "wipes" });
  const state = editor.draftState("  ", "옛값");
  assert.equal(state.wipes, true);
  assert.equal("clears" in state, false);
  assert.deepEqual(
    { value: state.value, length: state.length, changed: state.changed, tooLong: state.tooLong, canSave: state.canSave },
    { value: null, length: 0, changed: true, tooLong: false, canSave: true },
  );
});

test("규격으로 만든 편집기의 저장은 같은 정규화 규칙과 상한을 쓴다", async () => {
  const editor = accountTextEditor({ ...shortRules, clearsAs: "wipes" });
  const calls = [];
  const save = async (value) => {
    calls.push(value);
    return null;
  };
  assert.deepEqual(await editor.submit("abcdef", null, save), { requested: false, close: false, error: null });
  assert.deepEqual(await editor.submit("  새값  ", null, save), { requested: true, close: true, error: null });
  assert.deepEqual(calls, ["새값"]);
});
