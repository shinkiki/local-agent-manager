import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectPath } from "./aiaProjectCleanup.ts";
import { dismissAiaSuggestion } from "./aiaSuggestionHistory.ts";
import { evaluateAiaSuggestionState, evaluateAiaSuggestions } from "./aiaSuggestions.ts";
import { NOW, catalog, definition, evaluation, manager, session } from "./aiaSuggestionFixtures.mjs";

test("project cleanup groups normalized cwd across providers and applies exact default thresholds", () => {
  const sessions = Array.from({ length: 8 }, (_, index) => session(`s${index}`, {
    source: index % 2 ? "codex" : "claude",
    cwd: index % 2 ? "/work/alpha/./" : "/work/alpha",
    meta: { favorite: false, hidden: false, note: null, customTitle: null, folderIds: index < 5 ? [] : ["folder"] },
  }));
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager(sessions),
  }));
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].targetId, "/work/alpha");
  assert.equal(suggestions[0].metadata.sessionCount, 8);
  assert.equal(suggestions[0].metadata.unfiledCount, 5);

  sessions[4].meta.folderIds = ["folder"];
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager(sessions),
  })).length, 0);
});

test("project cleanup excludes hidden, archived, unreadable, subagent and AIA workspace sessions", () => {
  const included = Array.from({ length: 7 }, (_, index) => session(`included-${index}`));
  const excluded = [
    session("hidden", { meta: { favorite: false, hidden: true, note: null, customTitle: null, folderIds: [] } }),
    session("archived", { archived: true }),
    session("unreadable", { readable: false }),
    session("subagent", { isSubagent: true }),
    session("aia", { aiaWorkspace: true }),
  ];
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager([...included, ...excluded]),
  })).length, 0);
});

test("project cleanup returns at most three projects sorted by unfiled count then recency", () => {
  const sessions = [];
  const specs = [
    ["alpha", 6, NOW - 50],
    ["beta", 7, NOW - 500],
    ["charlie", 6, NOW - 10],
    ["delta", 5, NOW],
  ];
  for (const [name, unfiled, updatedAt] of specs) {
    for (let index = 0; index < 8; index += 1) {
      sessions.push(session(`${name}-${index}`, {
        project: name,
        cwd: `/work/${name}`,
        updatedAt,
        meta: { favorite: false, hidden: false, note: null, customTitle: null, folderIds: index < unfiled ? [] : ["folder"] },
      }));
    }
  }
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(definition("projectSessionCleanup")),
    manager: manager(sessions),
  }));
  assert.deepEqual(suggestions.map((item) => item.targetId), ["/work/beta", "/work/charlie", "/work/alpha"]);
});

test("project dismissal rearms after three more unfiled sessions or resolve and recross", () => {
  const projectDefinition = definition("projectSessionCleanup");
  const original = Array.from({ length: 8 }, (_, index) => session(`original-${index}`));
  const initial = evaluateAiaSuggestionState(evaluation({ catalog: catalog(projectDefinition), manager: manager(original) }));
  const dismissed = dismissAiaSuggestion(initial.history, initial.suggestions[0], NOW);

  const plusTwo = [...original, session("nine"), session("ten")];
  assert.equal(evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(plusTwo), history: dismissed,
  })).suggestions.length, 0);

  const plusThree = [...plusTwo, session("eleven")];
  assert.equal(evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(plusThree), history: dismissed,
  })).suggestions.length, 1);

  const resolvedSessions = original.map((item) => ({
    ...item,
    meta: { ...item.meta, folderIds: ["folder"] },
  }));
  const resolved = evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(resolvedSessions), history: dismissed,
  }));
  assert.equal(Object.values(resolved.history.projectDismissals)[0].resolved, true);
  assert.equal(evaluateAiaSuggestionState(evaluation({
    catalog: catalog(projectDefinition), manager: manager(original), history: resolved.history,
  })).suggestions.length, 1);
});

test("path normalization is lexical and deterministic", () => {
  assert.equal(normalizeProjectPath(" /work/alpha/../beta/ "), "/work/beta");
  assert.equal(normalizeProjectPath("C:\\Work\\Alpha\\"), "c:/Work/Alpha");
  assert.equal(normalizeProjectPath(""), null);
});

test("path normalization keeps the prefix when no segment survives", () => {
  // 갈래마다 조각이 하나도 남지 않을 때의 모양. 이어 붙이기를 한 줄로 모으면서
  // 이 셋이 갈래별 꼬리 손질에 기대고 있던 값이라 그대로인지 못 박아 둔다.
  assert.equal(normalizeProjectPath("C:\\"), "c:");
  assert.equal(normalizeProjectPath("/"), "/");
  assert.equal(normalizeProjectPath("./"), null);
});
