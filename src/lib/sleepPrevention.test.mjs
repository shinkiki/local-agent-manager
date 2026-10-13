import assert from "node:assert/strict";
import test from "node:test";
import { sleepToggleDisabled } from "./sleepPrevention.ts";

const open = { loaded: true, busy: false };

test("수단이 있는 호스트에서는 켤 수 있다", () => {
  assert.equal(sleepToggleDisabled({ supported: true, enabled: false }, open), false);
  assert.equal(sleepToggleDisabled({ supported: true, enabled: true }, open), false);
});

test("수단이 없는 호스트에서는 켜는 방향을 막는다", () => {
  // NAS 컨테이너 실측(2026-10-10): systemd-inhibit이 없어 get_sleep_prevention이
  // {supported:false, enabled:false, error:null}로 온다.
  assert.equal(sleepToggleDisabled({ supported: false, enabled: false }, open), true);
});

test("수단이 없어도 이미 켜진 값은 끌 수 있다", () => {
  assert.equal(sleepToggleDisabled({ supported: false, enabled: true }, open), false);
});

test("읽기 전용·작업 중에는 방향과 무관하게 막는다", () => {
  assert.equal(sleepToggleDisabled({ supported: true, enabled: true }, { loaded: false, busy: false }), true);
  assert.equal(sleepToggleDisabled({ supported: true, enabled: true }, { loaded: true, busy: true }), true);
});

test("상태를 아직 읽지 못했으면 막는다", () => {
  assert.equal(sleepToggleDisabled(null, open), true);
});
