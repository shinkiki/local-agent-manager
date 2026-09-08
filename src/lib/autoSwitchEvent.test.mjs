import assert from "node:assert/strict";
import test from "node:test";

import { autoSwitchEventSummary, autoSwitchReasonLabel } from "./autoSwitchEvent.ts";

const ACCOUNTS = [
  { id: "codex-a", displayName: "업무" },
  { id: "codex-b", displayName: "예비" },
];

function event(overrides = {}) {
  return {
    fromAccountId: "codex-a",
    toAccountId: "codex-b",
    reason: "usageExhausted",
    at: 1_700_000_000_000,
    resumedSessionCount: 0,
    ...overrides,
  };
}

test("트리거마다 다른 설명을 주고, 알 수 없는 값은 에이전트 제한 응답으로 본다", () => {
  assert.equal(autoSwitchReasonLabel("usageExhausted"), "사용량 100% 도달");
  assert.equal(autoSwitchReasonLabel("usageSpread"), "사용량 격차 도달");
  assert.equal(autoSwitchReasonLabel("agentLimited"), "에이전트 제한 응답");
});

test("본문은 표시 이름으로 옮긴 계정 사이의 전환과 트리거를 담는다", () => {
  const summary = autoSwitchEventSummary(ACCOUNTS, event());

  assert.equal(summary.fromName, "업무");
  assert.equal(summary.toName, "예비");
  assert.equal(summary.reason, "사용량 100% 도달");
  assert.equal(summary.transition, "업무 → 예비 · 사용량 100% 도달");
});

test("목록에 없는 계정은 id를 그대로 남겨 어느 계정 사이인지는 잃지 않는다", () => {
  const summary = autoSwitchEventSummary(ACCOUNTS, event({ fromAccountId: "codex-deleted" }));

  assert.equal(summary.fromName, "codex-deleted");
  assert.equal(summary.transition, "codex-deleted → 예비 · 사용량 100% 도달");
  assert.equal(autoSwitchEventSummary([], event()).transition, "codex-a → codex-b · 사용량 100% 도달");
});

test("복원 꼬리표는 복원된 세션이 있을 때만 붙어 그대로 이어 붙일 수 있다", () => {
  assert.equal(autoSwitchEventSummary(ACCOUNTS, event()).resumedNote, "");
  assert.equal(
    autoSwitchEventSummary(ACCOUNTS, event({ resumedSessionCount: 3 })).resumedNote,
    " · 세션 3개 복원",
  );
});

test("시각과 공급자 이름은 조각에 섞지 않는다 — 표시 지점이 각자 붙인다", () => {
  const summary = autoSwitchEventSummary(ACCOUNTS, event({ at: 1_700_000_000_000 }));

  assert.equal(summary.transition.includes("1700000000000"), false);
  assert.deepEqual(Object.keys(summary).sort(), ["fromName", "reason", "resumedNote", "toName", "transition"]);
});
