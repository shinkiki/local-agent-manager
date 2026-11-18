import assert from "node:assert/strict";
import test from "node:test";

import { humanPendingDecisionCount, humanPendingDecisionCountsByGoal, isRoundAnswerable, roundAnswerableDecisionCount } from "./roundDecisions.ts";

const report = {
  decisions: [
    { question: "a", options: ["x", "y"], recommendation: "x" },
    { question: "b", options: ["x", "y"], recommendation: "x", requiresHuman: true },
    { question: "c", options: ["x", "y"], recommendation: null },
    { question: "d", options: ["x", "y"], recommendation: "x", resolved: "x" },
  ],
};

test("manual leaves every pending decision to a person", () => {
  assert.equal(humanPendingDecisionCount(report, "manual"), 3);
  assert.equal(roundAnswerableDecisionCount(report, "manual"), 0);
});

test("recommended hands over only non-human decisions that carry a recommendation", () => {
  assert.equal(humanPendingDecisionCount(report, "recommended"), 2);
  assert.equal(roundAnswerableDecisionCount(report, "recommended"), 1);
  assert.equal(isRoundAnswerable(report.decisions[1], "recommended"), false);
  assert.equal(isRoundAnswerable({ question: "e", options: [], recommendation: "  " }, "recommended"), false);
});

test("automatic hands every pending decision to the next round", () => {
  assert.equal(humanPendingDecisionCount(report, "automatic"), 0);
  assert.equal(roundAnswerableDecisionCount(report, "automatic"), 3);
  assert.equal(isRoundAnswerable(report.decisions[3], "automatic"), false);
  // 완전자동은 사람 결정 표시와 무관하게 회차가 답한다(rounds.rs 와 같다).
  assert.equal(isRoundAnswerable(report.decisions[1], "automatic"), true);
});

test("V4: goal badges use each goal's decision mode", () => {
  const goals = [
    { id: "goal-manual", decisionMode: "manual" },
    { id: "goal-recommended", decisionMode: "recommended" },
    { id: "goal-automatic", decisionMode: "automatic" },
  ];
  const reports = goals.map((goal) => ({ ...report, goalId: goal.id }));
  assert.deepEqual(humanPendingDecisionCountsByGoal(reports, goals), {
    "goal-manual": 3,
    "goal-recommended": 2,
    "goal-automatic": 0,
  });
});

test("V4: goal badges sum reports separately and leave resolved decisions out", () => {
  const goals = [{ id: "goal-a", decisionMode: "manual" }, { id: "goal-b", decisionMode: "manual" }];
  const reports = [
    { ...report, goalId: "goal-a" },
    { goalId: "goal-a", decisions: [report.decisions[1], report.decisions[3]] },
    { goalId: "goal-b", decisions: [report.decisions[2]] },
  ];
  const before = structuredClone({ reports, goals });
  assert.deepEqual(humanPendingDecisionCountsByGoal(reports, goals), { "goal-a": 4, "goal-b": 1 });
  assert.deepEqual({ reports, goals }, before);
});

test("V4: reports without a goal are skipped and unavailable goal modes default to manual", () => {
  const reports = [
    { ...report, goalId: null },
    { ...report, goalId: "" },
    { ...report, goalId: "goal-deleted" },
    { ...report, goalId: "goal-legacy" },
  ];
  assert.deepEqual(humanPendingDecisionCountsByGoal(reports, [{ id: "goal-legacy" }]), {
    "goal-deleted": 3,
    "goal-legacy": 3,
  });
});

test("V4: empty report lists do not create goal badges", () => {
  assert.deepEqual(humanPendingDecisionCountsByGoal([], []), {});
  assert.deepEqual(humanPendingDecisionCountsByGoal([], [{ id: "goal-a", decisionMode: "manual" }]), {});
});
