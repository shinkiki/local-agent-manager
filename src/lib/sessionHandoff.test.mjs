import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionHandoffMessage, sessionHandoffContext } from "./sessionHandoff.ts";

const item = (role, text, extraBlocks = []) => ({
  index: 0,
  role,
  timestamp: null,
  model: null,
  typeLabel: null,
  usage: null,
  blocks: [{ kind: "text", text }, ...extraBlocks],
});

test("handoff context keeps only user and assistant text", () => {
  const context = sessionHandoffContext([
    item("system", "secret system text"),
    item("user", "원인 확인해줘", [{ kind: "tool_result", text: "tool output", isError: false }]),
    item("assistant", "현재 경로를 확인했습니다"),
    item("meta", "provider metadata"),
  ]);

  assert.equal(context, "사용자:\n원인 확인해줘\n\n에이전트:\n현재 경로를 확인했습니다");
  assert.doesNotMatch(context, /secret|tool output|metadata/);
});

test("handoff context drops provider meta blocks folded away on screen", () => {
  const context = sessionHandoffContext([
    item(
      "assistant",
      "검증을 마쳤습니다.\n\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[hidden]\n</citation_entries>\n</oai-mem-citation>",
    ),
  ]);

  assert.equal(context, "에이전트:\n검증을 마쳤습니다.");
  assert.doesNotMatch(context, /oai-mem-citation|MEMORY\.md/);
});

test("handoff message identifies the origin and separates the new request", () => {
  const message = buildSessionHandoffMessage({
    source: "claude",
    sessionId: "session-1",
    transcript: [item("user", "기존 요청")],
    request: "Codex로 계속 구현해줘",
  });

  assert.match(message, /원본 세션: claude:session-1/);
  assert.match(message, /<handoff_context>[\s\S]*기존 요청[\s\S]*<\/handoff_context>/);
  assert.match(message, /<new_request>[\s\S]*Codex로 계속 구현해줘[\s\S]*<\/new_request>/);
});

test("handoff context retains the newest text within the size limit", () => {
  const context = sessionHandoffContext([
    item("user", `old-${"a".repeat(24_000)}`),
    item("assistant", "newest-answer"),
  ]);

  assert.ok(context.length <= 24_000);
  assert.match(context, /newest-answer$/);
});
