import assert from "node:assert/strict";
import { test } from "node:test";

import { roundDesignPrompt } from "./roundDesign.ts";

const goal = {
  id: "goal-1", title: "계획 프로토콜 파인튜닝", goal: "통과 궤적으로 LoRA 를 학습한다", targetPath: "F:/repo",
  verification: "", cadence: "0 3 * * *", status: "draft", notes: "", createdAt: 0, updatedAt: 0,
};

// M10: 요청문은 목표의 사실과 끝낼 때 할 일만 적고, 승인을 건너뛰라고 말하지 않는다.
test("설계 요청문은 스킬 이름·목표 id·사실·마무리 지시를 담는다", () => {
  const prompt = roundDesignPrompt(goal);
  assert.match(prompt, /^round-designer 스킬을 따라/);
  assert.ok(prompt.includes("목표 id: goal-1"));
  assert.ok(prompt.includes("- 대상 경로: F:/repo"));
  assert.ok(prompt.includes("- 검증 방식: (설계가 정한다"), "비운 칸은 설계가 정한다고 적는다");
  assert.ok(prompt.includes("- 주기: 0 3 * * *"));
  assert.ok(prompt.includes("update_round_goal"));
  assert.ok(prompt.includes("record_round_report"));
  assert.ok(prompt.includes("승인 카드"));
  assert.ok(!/승인 없이|건너/.test(prompt));
});
