import assert from "node:assert/strict";
import test from "node:test";
import { editableTranscriptText, supportsMessageEdit } from "./messageEdit.ts";

test("G1/G2 edit expectedText preserves authoritative whitespace and block separators", () => {
  assert.equal(editableTranscriptText({ role: "user", blocks: [{ kind: "text", text: " first " }, { kind: "text", text: "second\n" }] }), " first \n\nsecond\n");
});
test("editing refuses attachments, non-user records and empty input", () => {
  for (const item of [
    { role: "assistant", blocks: [{ kind: "text", text: "answer" }] },
    { role: "user", blocks: [{ kind: "text", text: "question" }, { kind: "image" }] },
    { role: "user", blocks: [] },
    { role: "user", blocks: [{ kind: "text", text: "  \n" }] },
  ]) assert.equal(editableTranscriptText(item), null);
});
test("edit capability is restricted to providers with official fork boundaries", () => {
  for (const source of ["codex", "claude"]) assert.equal(supportsMessageEdit(source), true);
  for (const source of [null, "antigravity", "local"]) assert.equal(supportsMessageEdit(source), false);
});
