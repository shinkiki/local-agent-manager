import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalModeLabel,
  effectiveApprovalMode,
  fallbackSettingFields,
  permissionModeLabel,
  reasoningLabel,
} from "./chatModes.ts";

test("공급자별 내장 실행·승인 선택지가 CLI 지원 범위를 포함한다", () => {
  assert.deepEqual(
    fallbackSettingFields("claude").find((item) => item.key === "mode").options.map((item) => item.value),
    ["plan", "workspace", "fullAccess", "auto", "dontAsk", "manual"],
  );
  assert.deepEqual(
    fallbackSettingFields("codex").find((item) => item.key === "approvalMode").options.map((item) => item.value),
    ["manual", "autoReview", "granular", "onFailure", "never"],
  );
  // Codex 전용 승인은 다른 공급자 목록에서 빠지고, 자동 검토만 비활성으로 남는다.
  const claudeApprovals = fallbackSettingFields("claude").find((item) => item.key === "approvalMode").options;
  assert.deepEqual(claudeApprovals.map((item) => item.value), ["manual", "autoReview", "never"]);
  assert.deepEqual(claudeApprovals.map((item) => Boolean(item.disabled)), [false, true, false]);
  // 비활성으로 남기는 선택지는 어느 공급자 전용인지 안내 문구로 알린다.
  assert.equal(claudeApprovals.find((item) => item.value === "autoReview").detail, "Codex 전용");
  assert.equal(effectiveApprovalMode("claude", "granular"), "manual");
  assert.equal(effectiveApprovalMode("antigravity", "onFailure"), "manual");
  assert.equal(approvalModeLabel("granular"), "세분화 승인");
  assert.equal(approvalModeLabel("onFailure"), "실패 시 승인");
  assert.equal(permissionModeLabel("dontAsk"), "추가 권한 차단");
});

test("Codex none 추론은 공급자 기본값 미지정과 다른 별도 표시값이다", () => {
  assert.equal(reasoningLabel("none"), "없음");
  assert.notEqual(reasoningLabel("none"), "기본");
});

test("내장 문구가 없는 추론 수준은 이름을 그대로 보여준다", () => {
  assert.equal(reasoningLabel("brandNew"), "brandNew");
});

test("Antigravity는 승인 처리 항목을 내지 않는다", () => {
  assert.deepEqual(
    fallbackSettingFields("antigravity").map((item) => item.key),
    ["mode"],
  );
});
