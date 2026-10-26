import assert from "node:assert/strict";
import test from "node:test";

import { LOADING_VEIL_MAX_MS, PLACING_VEIL_MAX_MS, openingVeilPhase, openingVeilSettle } from "./openingVeil.ts";

const base = { openKey: "s1", doneKey: null, loading: false, placing: false };

test("여는 동안은 읽는 단계에서 자리 잡는 단계로 이어지고, 둘 다 아니면 막이 없다", () => {
  assert.equal(openingVeilPhase({ ...base, loading: true }), "loading");
  assert.equal(openingVeilPhase({ ...base, loading: true, placing: true }), "loading");
  assert.equal(openingVeilPhase({ ...base, placing: true }), "placing");
  assert.equal(openingVeilPhase(base), null);
});

test("대상이 없으면 가리지 않고, 끝낼 것도 없다", () => {
  assert.equal(openingVeilPhase({ ...base, openKey: null, loading: true }), null);
  assert.equal(openingVeilSettle({ ...base, openKey: null, loading: true }), null);
});

test("한 번 걷힌 대상에서는 늦게 온 원문이 막을 다시 세우지 않는다", () => {
  const done = { ...base, doneKey: "s1" };
  assert.equal(openingVeilPhase({ ...done, loading: true }), null);
  assert.equal(openingVeilPhase({ ...done, placing: true }), null);
  assert.equal(openingVeilSettle({ ...done, loading: true }), null);
});

test("다른 대상을 열면 다시 가린다", () => {
  assert.equal(openingVeilPhase({ ...base, doneKey: "s1", openKey: "s2", loading: true }), "loading");
  assert.equal(openingVeilSettle({ ...base, doneKey: "s1", openKey: "s2", loading: true }), LOADING_VEIL_MAX_MS);
});

test("바로 봐야 할 오류가 뜨면 가리지 않고 여는 동안을 이 렌더에서 끝낸다", () => {
  const interrupted = { ...base, loading: true, placing: true, interrupt: true };
  assert.equal(openingVeilPhase(interrupted), null);
  assert.equal(openingVeilSettle(interrupted), "now");
});

test("가릴 단계가 없어지면 그 렌더에서 끝내고, 단계마다 제 상한을 돌려준다", () => {
  assert.equal(openingVeilSettle(base), "now");
  assert.equal(openingVeilSettle({ ...base, loading: true }), LOADING_VEIL_MAX_MS);
  assert.equal(openingVeilSettle({ ...base, placing: true }), PLACING_VEIL_MAX_MS);
  // 읽는 단계가 자리 잡기보다 넉넉하다 — 큰 원문은 읽는 데만 몇 초가 걸린다.
  assert.ok(LOADING_VEIL_MAX_MS > PLACING_VEIL_MAX_MS);
});
