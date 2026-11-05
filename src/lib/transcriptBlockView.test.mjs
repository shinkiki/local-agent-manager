import assert from "node:assert/strict";
import test from "node:test";
import {
  isActivityBlock,
  isConversationActivityBlock,
  isConversationBlock,
  visibleTranscriptBlocks,
} from "./transcriptBlockView.ts";

const item = (blocks) => ({ blocks });
const kinds = (entry, view) => visibleTranscriptBlocks(entry, view).visible.map((block) => block.kind);

test("V2: conversation, activity and collapsed logs keep their distinct block categories", () => {
  const entry = item([
    { kind: "text", text: "answer" }, { kind: "image" }, { kind: "thinking", text: "reason" },
    { kind: "context" }, { kind: "session_info" }, { kind: "raw" }, { kind: "runtime_failure" },
  ]);
  assert.deepEqual(kinds(entry, "conversation"), ["text", "image", "runtime_failure"]);
  assert.deepEqual(kinds(entry, "activity"), ["thinking", "context", "session_info", "raw", "runtime_failure"]);
  assert.deepEqual(kinds(entry, "operational"), ["thinking"]);
});

test("V2: tool captures follow both tool calls and results regardless of block order", () => {
  for (const tool of [{ kind: "tool_use", name: "Read" }, { kind: "tool_result", text: "done" }]) {
    for (const blocks of [[{ kind: "image" }, tool], [tool, { kind: "image" }]]) {
      const entry = item(blocks);
      assert.deepEqual(kinds(entry, "conversation"), []);
      assert.deepEqual(visibleTranscriptBlocks(entry, "activity").visible, blocks);
      assert.deepEqual(visibleTranscriptBlocks(entry, "operational").visible, blocks);
    }
  }
  assert.deepEqual(kinds(item([{ kind: "image" }]), "conversation"), ["image"]);
});

test("V2: skill cards replace only skill invocations in collapsed logs", () => {
  const entry = item([
    { kind: "tool_use", name: "Skill" },
    { kind: "tool_result", text: "Launching skill: example" },
    { kind: "tool_use", name: "Read" },
    { kind: "tool_result", text: "ordinary result" },
  ]);
  assert.deepEqual(visibleTranscriptBlocks(entry, "activity").visible, entry.blocks);
  assert.deepEqual(visibleTranscriptBlocks(entry, "operational").visible, entry.blocks.slice(2));
});

test("V2: card metadata describes only retained blocks and preserves their identity", () => {
  const entry = item([{ kind: "text", text: "answer" }, { kind: "session_info" }, { kind: "thinking" }]);
  const original = structuredClone(entry);
  const conversation = visibleTranscriptBlocks(entry, "conversation");
  assert.deepEqual([...conversation.groups], ["message"]);
  assert.equal(conversation.hasSessionInfo, false);
  assert.equal(conversation.visible[0], entry.blocks[0]);
  const activity = visibleTranscriptBlocks(entry, "activity");
  assert.deepEqual([...activity.groups], ["context", "reasoning"]);
  assert.equal(activity.hasSessionInfo, true);
  assert.deepEqual(entry, original);
  assert.deepEqual(visibleTranscriptBlocks(item([]), "activity"), {
    visible: [], groups: new Set(), hasSessionInfo: false,
  });
});

test("V2: turn selection keeps the expected blocks in each view", () => {
  const entry = item([
    { kind: "text" }, { kind: "image" }, { kind: "tool_use", name: "Skill" },
    { kind: "tool_use", name: "Read" }, { kind: "thinking" }, { kind: "context" },
    { kind: "session_info" }, { kind: "raw" }, { kind: "runtime_failure" },
  ]);
  for (const [predicate, indices] of [
    [isConversationBlock, [0, 8]], [isActivityBlock, [1, 2, 3, 4, 5, 6, 7, 8]],
    [isConversationActivityBlock, [1, 3, 4]],
  ]) {
    assert.deepEqual(entry.blocks.filter((block) => predicate(block, entry)), indices.map((index) => entry.blocks[index]));
  }
});
