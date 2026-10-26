import assert from "node:assert/strict";
import test from "node:test";
import { fallbackSettingFields } from "./chatSettings.ts";
import { runtimeSettingsMessages } from "./runtimeSettingsMessages.ts";

const ko = (korean) => korean;

function messages(source, approvalMode, mode = "workspace") {
  const fields = fallbackSettingFields(source);
  return runtimeSettingsMessages({
    fields,
    mode,
    approvalMode,
    hasApprovalField: fields.some((field) => field.key === "approvalMode"),
    model: "",
    modelChoices: [],
    reasoningEffort: "",
    agentChangeable: false,
  }, ko);
}

test("승인 항목이 있는 공급자는 고른 승인 방식의 안내를 낸다", () => {
  assert.match(messages("codex", "autoReview").approvalModeHint ?? "", /자동 검토/);
});

test("승인 항목이 없는 공급자는 남아 있는 옛 승인 값의 안내를 내지 않는다", () => {
  const result = messages("antigravity", "autoReview");
  assert.equal(result.approvalModeHint, null);
  // 요약 칩도 같은 판단으로 승인 값을 싣지 않는다.
  assert.equal(result.summary.split(" · ").length, 3);
  assert.doesNotMatch(result.summary, /autoReview|자동 검토/);
});

test("승인 항목이 없는 공급자의 전체 접근은 승인 없음으로 보고 샌드박스 경고를 낸다", () => {
  assert.match(messages("antigravity", "autoReview", "fullAccess").warning ?? "", /샌드박스 없이/);
});
