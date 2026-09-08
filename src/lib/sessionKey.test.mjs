import assert from "node:assert/strict";
import test from "node:test";
import { sessionKey } from "./sessionKey.ts";

test("the provider is part of the key so two providers cannot share a session id", () => {
  assert.notEqual(sessionKey("codex", "abc"), sessionKey("claude", "abc"));
  assert.equal(sessionKey("codex", "abc"), sessionKey("codex", "abc"));
});

test("the separator is one no session id can contain, so neighbouring fields never merge", () => {
  assert.equal(sessionKey("codex", "abc"), "codex\u0000abc");
  assert.notEqual(sessionKey("codex", "abc"), "codexabc");
});
