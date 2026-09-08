import assert from "node:assert/strict";
import test from "node:test";

import { activityMatches, transcriptActivityMatches } from "./activityFilter.ts";

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
