import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalModeLabel,
  effectiveApprovalMode,
  fallbackSettingFields,
  normalizeExtraSettings,
  normalizeSettingValue,
  permissionModeLabel,
  reasoningLabel,
  settingFieldsFor,
} from "./chatSettings.ts";

const field = (key, options, defaultValue = null) => ({
  key,
  label: key,
  detail: null,
  kind: "enum",
  options,
  defaultValue,
});

const option = (value, disabled = false) => ({ value, label: value, detail: null, disabled });

test("최신 스키마에 남아 있는 값은 그대로 유지한다", () => {
  const fields = [field("mode", [option("plan"), option("workspace")], "workspace")];
  assert.equal(normalizeSettingValue(fields, "mode", "plan"), "plan");
});

test("CLI가 더 이상 받지 않는 값은 스키마 기본값으로 되돌린다", () => {
  const fields = [field("mode", [option("plan"), option("workspace")], "workspace")];
  assert.equal(normalizeSettingValue(fields, "mode", "fullAccess"), "workspace");
});

test("기본값도 사라졌으면 고를 수 있는 첫 선택지를 쓴다", () => {
  const fields = [field("mode", [option("plan"), option("workspace")], "fullAccess")];
  assert.equal(normalizeSettingValue(fields, "mode", "fullAccess"), "plan");
});

test("비활성 선택지는 고르지 않는다", () => {
  const fields = [field("approvalMode", [option("manual"), option("autoReview", true)], "manual")];
  assert.equal(normalizeSettingValue(fields, "approvalMode", "autoReview"), "manual");
  // 기본값이 비활성이면 활성 선택지로 넘어간다.
  const gated = [field("approvalMode", [option("autoReview", true), option("never")], "autoReview")];
  assert.equal(normalizeSettingValue(gated, "approvalMode", "autoReview"), "never");
});

test("스키마에 없는 항목은 판단하지 않고 값을 보존한다", () => {
  assert.equal(normalizeSettingValue([], "mode", "workspace"), "workspace");
});

test("Codex 기본 승인 처리는 정규화 후에도 자동 검토로 남는다", () => {
  const fields = settingFieldsFor(null, "codex");
  assert.equal(normalizeSettingValue(fields, "approvalMode", "autoReview"), "autoReview");
  // Claude에서는 자동 검토가 비활성이므로 직접 승인으로 내려간다.
  assert.equal(normalizeSettingValue(fallbackSettingFields("claude"), "approvalMode", "autoReview"), "manual");
});

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

test("추가 실행설정은 스키마에 남은 항목과 허용값만 통과한다", () => {
  const fields = [
    { key: "fallbackModel", label: "예비 모델", detail: null, kind: "text", options: [], defaultValue: null },
    field("reviewer", [option("auto"), option("off", true)]),
  ];
  assert.deepEqual(
    normalizeExtraSettings(fields, {
      fallbackModel: "claude-sonnet-5",
      reviewer: "auto",
      removedByDiscovery: "value",
      blank: "  ",
    }),
    { fallbackModel: "claude-sonnet-5", reviewer: "auto" },
  );
  // 비활성 선택지 값은 떨어낸다.
  assert.deepEqual(normalizeExtraSettings(fields, { reviewer: "off" }), {});
});
