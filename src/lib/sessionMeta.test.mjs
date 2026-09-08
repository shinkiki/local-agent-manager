import assert from "node:assert/strict";
import test from "node:test";
import { optimisticSessionMeta } from "./sessionMeta.ts";

const base = {
  favorite: false,
  hidden: false,
  note: null,
  customTitle: null,
  folderIds: [],
  reasoningEffort: null,
  mode: null,
  approvalMode: null,
  creationAccountId: null,
  boundAccountId: null,
  pinnedAccountId: null,
};

test("an absent field is left alone and the source object is not mutated", () => {
  const current = { ...base, favorite: true, note: "메모", folderIds: ["f1"] };
  const next = optimisticSessionMeta(current, { hidden: true });
  assert.equal(next.favorite, true);
  assert.equal(next.note, "메모");
  assert.deepEqual(next.folderIds, ["f1"]);
  assert.equal(next.hidden, true);
  assert.equal(current.hidden, false);
});

test("text fields are trimmed and blank values clear them", () => {
  const next = optimisticSessionMeta(base, { note: "  적어둠  ", customTitle: "   " });
  assert.equal(next.note, "적어둠");
  assert.equal(next.customTitle, null);
  assert.equal(optimisticSessionMeta(base, { note: null }).note, null);
});

test("folder ids drop duplicates while keeping order", () => {
  const next = optimisticSessionMeta(base, { folderIds: ["b", "a", "b"] });
  assert.deepEqual(next.folderIds, ["b", "a"]);
});

test("pinning an account trims the id and an empty value releases the pin", () => {
  assert.equal(optimisticSessionMeta(base, { pinnedAccountId: " acc-1 " }).pinnedAccountId, "acc-1");
  const pinned = { ...base, pinnedAccountId: "acc-1" };
  assert.equal(optimisticSessionMeta(pinned, { pinnedAccountId: null }).pinnedAccountId, null);
  assert.equal(optimisticSessionMeta(pinned, { pinnedAccountId: "" }).pinnedAccountId, null);
});
