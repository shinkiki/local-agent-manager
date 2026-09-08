import assert from "node:assert/strict";
import { test } from "node:test";
import { planExecutionRequest, planRestartMode } from "./planRestart.ts";

test("계획 본문을 경계 태그로 감싸 새 실행에 넘긴다", () => {
  const request = planExecutionRequest("# 계획\n\n1. 고친다", "claude");
  assert.match(request, /claude 실행에서 세워 사용자가 승인한 것입니다/);
  assert.match(request, /<approved_plan>\n\n# 계획\n\n1\. 고친다\n\n<\/approved_plan>/);
});

test("본문이 비면 계획을 다시 확인하라는 요청만 남는다", () => {
  assert.equal(
    planExecutionRequest("   ", "codex"),
    "직전 실행에서 세운 계획을 확인하고 이어서 진행하세요.",
  );
});

test("계획 모드로 다시 띄우면 계획만 다시 세우므로 작업 범위로 올린다", () => {
  assert.equal(planRestartMode("plan"), "workspace");
});

test("이미 계획 모드보다 넓으면 권한을 건드리지 않는다", () => {
  for (const mode of ["workspace", "auto", "dontAsk", "manual", "fullAccess"]) {
    assert.equal(planRestartMode(mode), mode);
  }
});
