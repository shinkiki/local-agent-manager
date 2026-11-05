import assert from "node:assert/strict";
import test from "node:test";
import { literalFold, matchesSessionQuery } from "./sessionSearch.ts";
import { sessionKey } from "./sessionKey.ts";

const session = (overrides = {}) => ({
  source: "codex",
  id: "sess-1",
  title: "Server 220.149.36.220 점검",
  project: null,
  cwd: "/srv/app",
  meta: { note: null },
  ...overrides,
});

test("literalFold matches the backend per-character fold, including final sigma", () => {
  // `toLowerCase` on the whole string turns a word-final Σ into ς; the backend folds per character to σ.
  assert.equal(literalFold("ΟΔΟΣ"), "οδοσ");
  assert.equal(literalFold("검색".normalize("NFD")), "검색");
  assert.equal(literalFold("ABC/Def"), "abc/def");
});

test("query is literal, trimmed and case/composition insensitive", () => {
  assert.equal(matchesSessionQuery(session(), "  server 220.149 ", []), true);
  assert.equal(matchesSessionQuery(session({ title: "220x149" }), "220.149", []), false);
  assert.equal(matchesSessionQuery(session({ title: "검색".normalize("NFD") }), "검색", []), true);
  // An empty query means "no filter" here; the backend `literal_match` returns false for it on purpose.
  assert.equal(matchesSessionQuery(session(), "   ", []), true);
});

test("query reads project, cwd, id, note and live chat ids", () => {
  assert.equal(matchesSessionQuery(session({ project: "Alpha" }), "alpha", []), true);
  assert.equal(matchesSessionQuery(session(), "/SRV/app", []), true);
  assert.equal(matchesSessionQuery(session(), "SESS-1", []), true);
  assert.equal(matchesSessionQuery(session({ meta: { note: "배포 메모" } }), "배포", []), true);
  assert.equal(matchesSessionQuery(session(), "chat-42", ["chat-42"]), true);
  assert.equal(matchesSessionQuery(session(), "chat-42", []), false);
});

test("a content-search hit keeps the session regardless of metadata", () => {
  const hit = new Map([[sessionKey("codex", "sess-1"), { source: "codex", id: "sess-1", index: 3, snippet: "x" }]]);
  assert.equal(matchesSessionQuery(session(), "nowhere-in-metadata", [], hit), true);
  assert.equal(matchesSessionQuery(session({ source: "claude" }), "nowhere-in-metadata", [], hit), false);
});
