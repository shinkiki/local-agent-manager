import assert from "node:assert/strict";
import test from "node:test";
import {
  canDispatchAiaEvent,
  emptyAiaEventBudget,
  parseAiaEventBudget,
  recordAiaEventDispatch,
  serializeAiaEventBudget,
} from "./aiaEventBudget.ts";
import { NOW } from "./aiaSuggestionFixtures.mjs";

test("AI event budget enforces six hours and two dispatches per rolling day", () => {
  let budget = emptyAiaEventBudget();
  assert.equal(canDispatchAiaEvent(budget, NOW), true);
  budget = recordAiaEventDispatch(budget, NOW);
  assert.equal(canDispatchAiaEvent(budget, NOW + 6 * 60 * 60_000 - 1), false);
  assert.equal(canDispatchAiaEvent(budget, NOW + 6 * 60 * 60_000), true);
  budget = recordAiaEventDispatch(budget, NOW + 6 * 60 * 60_000);
  assert.equal(canDispatchAiaEvent(budget, NOW + 13 * 60 * 60_000), false);
  assert.equal(canDispatchAiaEvent(budget, NOW + 24 * 60 * 60_000), true);
  assert.deepEqual(parseAiaEventBudget(serializeAiaEventBudget(budget)), budget);
});
