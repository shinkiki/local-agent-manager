import assert from "node:assert/strict";
import test from "node:test";
import { resolveLiveMessageEdit } from "./chatMessageEdit.ts";
const user = (index, text) => ({ index, role: "user", blocks: [{ kind: "text", text }] });

test("duplicate text is mapped by replay sequence, not the first matching message", () => {
  const transcript = [user(0, "same"), user(4, "next"), user(8, "same")];
  const replay = [{ id: "a", text: "same" }, { id: "b", text: "next" }, { id: "c", text: "same" }];
  assert.equal(resolveLiveMessageEdit(transcript, replay, "c")?.index, 8);
});

test("ambiguous truncated replay or not-yet-persisted input refuses editing", () => {
  assert.equal(resolveLiveMessageEdit([user(0, "same"), user(4, "same")], [{ id: "a", text: "same" }], "a"), null);
  assert.equal(resolveLiveMessageEdit([user(0, "old")], [{ id: "a", text: "new" }], "a"), null);
});

test("attachments and non-user records cannot become editable text", () => {
  assert.equal(resolveLiveMessageEdit([{ index: 0, role: "user", blocks: [{ kind: "image" }] }], [{ id: "a", text: "" }], "a"), null);
});
