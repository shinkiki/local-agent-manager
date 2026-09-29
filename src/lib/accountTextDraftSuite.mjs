/**
 * 계정 표시 이름·메모 두 편집기가 함께 도는 검사 한 벌.
 *
 * 두 편집기는 `accountTextDraft.ts`의 뼈대를 정규화 규칙과 길이 상한만 바꿔 쓰는데,
 * 그 뼈대를 지나는 아홉 가지 검사(빈 초안·무변경·상한 초과·저장·삭제·실패·미발송·
 * 글자 수)가 두 파일에 거의 그대로 두 벌 적혀 있었다. 검사가 두 벌이면 뼈대에 조건이
 * 하나 늘 때 한쪽에만 붙고, 그 뒤로는 "두 편집기가 같은 규칙을 쓴다"는 것을 아무도
 * 확인하지 않는다 — 편집기별 파일에 남아 있어야 하는 것은 정규화 규칙과 표본뿐이다.
 *
 * 파일 이름이 `*.test.mjs`가 아니므로 이 파일 자체는 실행 대상이 아니고, 두 편집기의
 * 검사 파일이 불러 자기 이름으로 등록한다.
 */
import assert from "node:assert/strict";
import test from "node:test";

/** 저장 호출을 기록하는 가짜 저장기. `error`를 주면 그 문구로 실패한다. */
export function recordingSave(error = null) {
  const calls = [];
  return {
    calls,
    save: async (value) => {
      calls.push(value);
      return error;
    },
  };
}

/**
 * 편집기 하나를 공용 뼈대 검사에 태운다. 편집기마다 다른 것은 이름·정규화 결과가
 * 붙은 표본과 저장하면 값이 사라지는 상태의 이름(`clearFlag`)뿐이다.
 */
export function testAccountTextEditor({
  editor,
  draftState,
  submit,
  maxChars,
  clearFlag,
  saved,
  savedRespaced,
  fresh,
  messyDraft,
  normalizedDraft,
  saveError,
  lengthSamples,
}) {
  const name = (what) => `${editor}: ${what}`;

  test(name("빈 초안은 저장돼 있던 값을 지우는 요청이 된다"), () => {
    const state = draftState("   ", saved);
    assert.equal(state.value, null);
    assert.equal(state[clearFlag], true);
    assert.equal(state.canSave, true);
  });

  test(name("값이 그대로면 저장할 수 없어 요청을 만들지 않는다"), () => {
    assert.equal(draftState(saved, saved).canSave, false);
    // 공백만 다른 입력은 정규화 후 같은 값이라 변경으로 보지 않는다.
    assert.equal(draftState(savedRespaced, saved).canSave, false);
    assert.equal(draftState("", null).canSave, false);
    assert.equal(draftState(fresh, null).canSave, true);
  });

  test(name("상한을 넘긴 초안은 지금 글자 수와 함께 요청 전에 막힌다"), () => {
    const longest = "가".repeat(maxChars);
    const atLimit = draftState(longest, null);
    assert.equal(atLimit.length, maxChars);
    assert.equal(atLimit.tooLong, false);
    assert.equal(atLimit.canSave, true);

    const overLimit = draftState(`${longest}가`, null);
    assert.equal(overLimit.length, maxChars + 1);
    assert.equal(overLimit.tooLong, true);
    assert.equal(overLimit.canSave, false);
  });

  test(name("저장은 정리한 값을 보내고 편집기를 닫는다"), async () => {
    const { calls, save } = recordingSave();
    const result = await submit(messyDraft, null, save);

    assert.deepEqual(calls, [normalizedDraft]);
    assert.deepEqual(result, { requested: true, close: true, error: null });
  });

  test(name("입력을 비우면 값을 지우는 요청을 보낸다"), async () => {
    const { calls, save } = recordingSave();
    const result = await submit("   ", saved, save);

    assert.deepEqual(calls, [null]);
    assert.equal(result.close, true);
  });

  test(name("저장에 실패하면 편집기를 열어 둔 채 사유를 그 안에 보여 준다"), async () => {
    const { calls, save } = recordingSave(saveError);
    const result = await submit(fresh, null, save);

    assert.deepEqual(calls, [fresh]);
    assert.deepEqual(result, { requested: true, close: false, error: saveError });
  });

  test(name("변경이 없거나 상한을 넘긴 초안은 백엔드까지 가지 않는다"), async () => {
    const unchanged = recordingSave();
    assert.deepEqual(await submit(saved, saved, unchanged.save), { requested: false, close: false, error: null });
    assert.deepEqual(unchanged.calls, []);

    const overLimit = recordingSave();
    const tooLong = "가".repeat(maxChars + 1);
    assert.deepEqual(await submit(tooLong, null, overLimit.save), { requested: false, close: false, error: null });
    assert.deepEqual(overLimit.calls, []);
  });

  test(name("글자 수는 Rust의 문자 수 기준과 같다"), () => {
    // 이모지 하나는 Rust의 chars().count()와 같이 한 글자로 센다. 화면이 읽는 자리가
    // 초안 상태의 `length`이므로 그 경로로 센다.
    for (const [draft, expected] of lengthSamples) {
      assert.equal(draftState(draft, null).length, expected, JSON.stringify(draft));
    }
  });
}
