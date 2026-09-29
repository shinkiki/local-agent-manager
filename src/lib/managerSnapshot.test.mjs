import assert from "node:assert/strict";
import test from "node:test";

import { mergeManagerSnapshot } from "./managerSnapshot.ts";

const session = (id, updatedAt, extra = {}) => ({ source: "claude", id, updatedAt, title: id, ...extra });

const snapshot = (sessions) => ({
  schemaVersion: 1,
  sessionCatalogRevision: 10,
  resourceCatalogRevision: 3,
  status: {},
  dashboard: {},
  sessions,
  folders: [],
  skills: [],
  agents: [],
  artifacts: [],
  pendingProjects: [],
});

const delta = (changedSessions, removedSessions = []) => ({
  kind: "delta",
  schemaVersion: 1,
  sessionCatalogRevision: 11,
  resourceCatalogRevision: 3,
  status: {},
  dashboard: {},
  folders: [],
  skills: [],
  agents: [],
  artifacts: [],
  pendingProjects: [],
  changedSessions,
  removedSessions,
});

test("mergeManagerSnapshot keeps the object identity of sessions the delta did not touch", () => {
  const untouched = session("b", 200);
  const previous = snapshot([session("a", 300), untouched, session("c", 100)]);
  const merged = mergeManagerSnapshot(previous, delta([session("c", 400)]));

  assert.deepEqual(merged.sessions.map((item) => item.id), ["c", "a", "b"]);
  assert.equal(merged.sessions[2], untouched, "바뀌지 않은 세션은 같은 객체여야 memo가 산다");
  assert.notEqual(merged.sessions[0], previous.sessions[2], "바뀐 세션은 새 객체로 교체된다");
  assert.equal(merged.sessionCatalogRevision, 11);
});

test("mergeManagerSnapshot returns the previous array itself when nothing changed", () => {
  const previous = snapshot([session("a", 300), session("b", 200)]);
  const merged = mergeManagerSnapshot(previous, delta([]));

  assert.equal(merged.sessions, previous.sessions);
  assert.equal(merged.sessionCatalogRevision, 11);
});

test("mergeManagerSnapshot drops removed sessions and appends new ones in updated order", () => {
  const previous = snapshot([session("a", 300), session("b", 200)]);
  const merged = mergeManagerSnapshot(previous, delta([session("new", 250)], [{ source: "claude", id: "a" }]));

  assert.deepEqual(merged.sessions.map((item) => item.id), ["new", "b"]);
});

test("mergeManagerSnapshot sorts sessions without an updated time last, like the backend", () => {
  const previous = snapshot([session("a", 300), session("none", null), session("b", 100)]);
  const merged = mergeManagerSnapshot(previous, delta([session("b", 400)]));

  assert.deepEqual(merged.sessions.map((item) => item.id), ["b", "a", "none"]);
});

test("mergeManagerSnapshot takes a full sync as the whole list and strips the discriminator", () => {
  const previous = snapshot([session("a", 300)]);
  const merged = mergeManagerSnapshot(previous, { kind: "full", ...snapshot([session("z", 10)]) });

  assert.deepEqual(merged.sessions.map((item) => item.id), ["z"]);
  assert.equal("kind" in merged, false);
});

test("mergeManagerSnapshot survives a delta that arrives with no previous list", () => {
  const merged = mergeManagerSnapshot(null, delta([session("a", 300)]));

  assert.deepEqual(merged.sessions.map((item) => item.id), ["a"]);
});
