import assert from "node:assert/strict";
import test from "node:test";
import {
  dismissAiaSuggestion,
  emptyAiaSuggestionHistory,
  parseAiaSuggestionHistory,
  serializeAiaSuggestionHistory,
} from "./aiaSuggestionHistory.ts";
import { evaluateAiaSuggestionState, evaluateAiaSuggestions } from "./aiaSuggestions.ts";
import {
  NOW,
  account,
  accountSnapshot,
  catalog,
  definition,
  evaluation,
  schedulerSnapshot,
} from "./aiaSuggestionFixtures.mjs";

test("fingerprints ignore pack version and presentation copy", () => {
  const first = definition("featureTip", { titleTemplate: "First" });
  const firstSuggestion = evaluateAiaSuggestions(evaluation({ catalog: catalog(first) }))[0];
  const changedCatalog = catalog(definition("featureTip", { titleTemplate: "Changed", promptTemplate: "Changed prompt" }));
  changedCatalog.packs[0].version = "99.0.0";
  const changedSuggestion = evaluateAiaSuggestions(evaluation({ catalog: changedCatalog }))[0];
  assert.equal(firstSuggestion.fingerprint, changedSuggestion.fingerprint);
});

test("feature tips and ordinary dismissed fingerprints persist without unsafe data", () => {
  const defs = [definition("featureTip"), definition("schedulerPaused")];
  const state = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(...defs), scheduler: schedulerSnapshot(true),
  }));
  let history = emptyAiaSuggestionHistory();
  for (const suggestion of state.suggestions) history = dismissAiaSuggestion(history, suggestion, NOW);
  const restored = parseAiaSuggestionHistory(serializeAiaSuggestionHistory(history));
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(...defs), scheduler: schedulerSnapshot(true), history: restored,
  })).length, 0);
  const authSuggestion = evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("accountAuthError")),
    accounts: accountSnapshot(account("private-account-id", { authStatus: "error" })),
  }))[0];
  const privateHistory = dismissAiaSuggestion(emptyAiaSuggestionHistory(), authSuggestion, NOW);
  assert.equal(serializeAiaSuggestionHistory(privateHistory).includes("private-account-id"), false);
  assert.deepEqual(parseAiaSuggestionHistory("not json"), emptyAiaSuggestionHistory());
});

test("ordinary dismissal rearms only after resolution when the pack enables it", () => {
  const paused = definition("schedulerPaused", { rearm: { afterResolved: true } });
  const activeInput = evaluation({ catalog: catalog(paused), scheduler: schedulerSnapshot(true) });
  const suggestion = evaluateAiaSuggestions(activeInput)[0];
  const dismissed = dismissAiaSuggestion(emptyAiaSuggestionHistory(), suggestion, NOW);
  const resolved = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(paused), scheduler: schedulerSnapshot(false), history: dismissed,
  }));
  assert.equal(Object.values(resolved.history.incidentDismissals)[0].resolved, true);
  assert.equal(evaluateAiaSuggestions({ ...activeInput, history: resolved.history }).length, 1);

  const cooldownDefinition = definition("schedulerPaused", { rearm: { afterResolved: true, cooldownMinutes: 60 } });
  const cooldownInput = evaluation({ catalog: catalog(cooldownDefinition), scheduler: schedulerSnapshot(true) });
  const cooldownSuggestion = evaluateAiaSuggestions(cooldownInput)[0];
  const cooldownHistory = dismissAiaSuggestion(emptyAiaSuggestionHistory(), cooldownSuggestion, NOW);
  assert.equal(evaluateAiaSuggestions({ ...cooldownInput, now: NOW + 59 * 60_000, history: cooldownHistory }).length, 0);
  assert.equal(evaluateAiaSuggestions({ ...cooldownInput, now: NOW + 60 * 60_000, history: cooldownHistory }).length, 1);
});

test("state changes do not bypass dismissal and afterResolved false stays dismissed", () => {
  const authDefinition = definition("accountAuthError", { rearm: { afterResolved: false } });
  const missingInput = evaluation({
    catalog: catalog(authDefinition),
    accounts: accountSnapshot(account("private-account", { authStatus: "missing" })),
  });
  const suggestion = evaluateAiaSuggestions(missingInput)[0];
  const dismissed = dismissAiaSuggestion(emptyAiaSuggestionHistory(), suggestion, NOW);

  const errorInput = {
    ...missingInput,
    accounts: accountSnapshot(account("private-account", { authStatus: "error" })),
    history: dismissed,
  };
  assert.equal(evaluateAiaSuggestions(errorInput).length, 0);

  const resolved = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(authDefinition),
    accounts: accountSnapshot(account("private-account")),
    history: dismissed,
  }));
  assert.equal(Object.values(resolved.history.incidentDismissals)[0].resolved, true);
  assert.equal(evaluateAiaSuggestions({ ...missingInput, history: resolved.history }).length, 0);
});
