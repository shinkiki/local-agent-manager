import assert from "node:assert/strict";
import test from "node:test";
import { indexPreferredRounds } from "./workflowPreferredRounds.ts";

const round = (id, workflowId, enabled) => ({ id, enabled, workflow: { workflowId } });

test("V4: empty and unbound schedules never become workflow representatives", () => {
  assert.deepEqual([...indexPreferredRounds([])], []);
  const bound = round("bound", "workflow", false);
  const rounds = indexPreferredRounds([
    { id: "chat", enabled: true },
    { id: "null", enabled: true, workflow: null },
    round("empty", "", true),
    bound,
  ]);
  assert.deepEqual([...rounds.keys()], ["workflow"]);
  assert.strictEqual(rounds.get("workflow"), bound);
});

test("V4: the first enabled round wins every four-round state combination, with first paused fallback", () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const schedules = Array.from({ length: 4 }, (_, i) => round(`round-${i}`, "workflow", Boolean(mask & (1 << i))));
    const expected = schedules.find((schedule) => schedule.enabled) ?? schedules[0];
    const rounds = indexPreferredRounds(schedules);
    assert.equal(rounds.size, 1, `mask ${mask}`);
    assert.strictEqual(rounds.get("workflow"), expected, `mask ${mask}`);
  }
});

test("V4: workflows select independently and keep first-seen key order even when a round is replaced", () => {
  const firstPaused = round("a-paused", "__proto__", false);
  const secondPaused = round("b-paused", "constructor", false);
  const firstActive = round("a-active", "__proto__", true);
  const secondActive = round("b-active", "constructor", true);
  const rounds = indexPreferredRounds([firstPaused, secondPaused, secondActive, firstActive]);
  assert.deepEqual([...rounds.keys()], ["__proto__", "constructor"]);
  assert.strictEqual(rounds.get("__proto__"), firstActive);
  assert.strictEqual(rounds.get("constructor"), secondActive);
});

test("V4: selection leaves frozen input intact and each refresh gets its own map", () => {
  const schedules = Object.freeze([
    Object.freeze({ id: "paused", enabled: false, workflow: Object.freeze({ workflowId: "workflow" }) }),
    Object.freeze({ id: "active", enabled: true, workflow: Object.freeze({ workflowId: "workflow" }) }),
  ]);
  const before = structuredClone(schedules);
  const first = indexPreferredRounds(schedules);
  const second = indexPreferredRounds(schedules);
  assert.notStrictEqual(first, second);
  first.clear();
  assert.strictEqual(second.get("workflow"), schedules[1]);
  assert.deepEqual(schedules, before);
});
