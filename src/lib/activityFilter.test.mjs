import assert from "node:assert/strict";
import test from "node:test";

import {
  activityMatches,
  liveActivityPredicate,
  transcriptActivityMatches,
  transcriptActivityPredicate,
} from "./activityFilter.ts";

test("skill filter keeps only live Skill tool entries", () => {
  assert.equal(activityMatches({ type: "tool", name: "Skill" }, "skill"), true);
  assert.equal(activityMatches({ type: "tool", name: "Bash" }, "skill"), false);
  assert.equal(activityMatches({ type: "message", role: "assistant", kind: "reasoning" }, "skill"), false);
});

test("skill filter recognizes named history context and Claude launch records", () => {
  assert.equal(transcriptActivityMatches([{ kind: "context", label: "사용 스킬 · kbfps-hrm" }], "skill"), true);
  assert.equal(transcriptActivityMatches([{ kind: "tool_use", name: "Skill" }], "skill"), true);
  assert.equal(transcriptActivityMatches([{ kind: "tool_result", text: "Launching skill: kbfps-hrm" }], "skill"), true);
  assert.equal(transcriptActivityMatches([{ kind: "context", label: "환경 컨텍스트" }], "skill"), false);
});

test("history filters preserve tool reasoning and error categories", () => {
  assert.equal(transcriptActivityMatches([{ kind: "tool_use", name: "Bash" }], "tool"), true);
  assert.equal(transcriptActivityMatches([{ kind: "thinking" }], "reasoning"), true);
  assert.equal(transcriptActivityMatches([{ kind: "tool_result", isError: true }], "error"), true);
  assert.equal(transcriptActivityMatches([{ kind: "tool_result", isError: false }], "error"), false);
});

test("error filter keeps runtime failure markers", () => {
  assert.equal(transcriptActivityMatches([{ kind: "runtime_failure" }], "error"), true);
  assert.equal(transcriptActivityMatches([{ kind: "runtime_failure" }], "all"), true);
  assert.equal(transcriptActivityMatches([{ kind: "runtime_failure" }], "tool"), false);
  assert.equal(transcriptActivityMatches([{ kind: "runtime_failure" }], "reasoning"), false);
});

test("live activity filter handles all, reasoning, and error categories", () => {
  assert.equal(activityMatches({ type: "error" }, "error"), true);
  assert.equal(activityMatches({ type: "approval" }, "error"), true);
  assert.equal(activityMatches({ type: "tool", name: "Bash" }, "error"), false);
  assert.equal(activityMatches({ type: "message", role: "assistant", kind: "reasoning" }, "reasoning"), true);
  assert.equal(activityMatches({ type: "message", role: "assistant", kind: "text" }, "reasoning"), false);
  assert.equal(activityMatches({ type: "message", role: "user", kind: "text" }, "all"), true);
  assert.equal(activityMatches({ type: "message", role: "assistant", kind: "text" }, "all"), false);
});

test("filter predicates return reusable matching functions", () => {
  const isReasoningLive = liveActivityPredicate("reasoning");
  assert.equal(isReasoningLive({ type: "message", role: "assistant", kind: "reasoning" }), true);
  assert.equal(isReasoningLive({ type: "tool", name: "Bash" }), false);

  const isAllTranscript = transcriptActivityPredicate("all");
  assert.equal(isAllTranscript({ kind: "random" }), true);

  const isToolTranscript = transcriptActivityPredicate("tool");
  assert.equal(isToolTranscript({ kind: "tool_use" }), true);
  assert.equal(isToolTranscript({ kind: "thinking" }), false);
});


