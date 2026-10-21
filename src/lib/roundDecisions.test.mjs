import assert from "node:assert/strict";
import test from "node:test";

import { humanPendingDecisionCount, isRoundAnswerable, roundAnswerableDecisionCount } from "./roundDecisions.ts";

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
