import assert from "node:assert/strict";
import test from "node:test";
import { coalesceAiaEvents } from "./aiaEvents.ts";

function event(id, priority = 80, observedAt = 1_000, summary = id) {
  return { id, kind: "scheduleFailed", targetId: "run", priority, observedAt, summary };
}

test("V2: coalescing preserves priority, observation time, id and stable ties", () => {
  const cases = [
    { events: [event("low", 10), event("high", 100, 2_000)], expected: "high" },
    { events: [event("new", 80, 2_000), event("old")], expected: "old" },
    { events: [event("z"), event("a")], expected: "a" },
    { events: [event("tie", 80, 1_000, "first"), event("tie", 80, 1_000, "second")], expected: "first" },
  ];
  for (const { events, expected } of cases) {
    const selected = coalesceAiaEvents(events, 32_000);
    assert.equal(selected.summary, expected);
    assert.equal(selected.coalescedCount, events.length);
  }
});

test("V2: the oldest event starts the window even when another event is selected", () => {
  const events = [event("new-high", 100, 20_000), event("old-low", 10, 1_000)];
  assert.equal(coalesceAiaEvents(events, 30_999), null);
  assert.equal(coalesceAiaEvents(events, 31_000).id, "new-high");
  assert.equal(coalesceAiaEvents(events, 1_009, 10), null);
  assert.equal(coalesceAiaEvents(events, 1_010, 10).id, "new-high");
  assert.equal(coalesceAiaEvents(events, 999, -10), null);
  assert.equal(coalesceAiaEvents(events, 1_000, -10).id, "new-high");
  assert.equal(coalesceAiaEvents([], 31_000), null);
});

test("V2: selecting a representative preserves the input and returns a new object", () => {
  const low = Object.freeze(event("low", 10));
  const high = Object.freeze({ ...event("high", 100), coalescedCount: 99 });
  const events = Object.freeze([low, high]);
  const selected = coalesceAiaEvents(events, 31_000);
  assert.deepEqual(events, [low, high]);
  assert.deepEqual(selected, { ...high, coalescedCount: 2 });
  assert.notEqual(selected, high);
  assert.equal(high.coalescedCount, 99);
});
