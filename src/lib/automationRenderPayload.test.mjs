import assert from "node:assert/strict";
import test from "node:test";
import { automationRenderPayload } from "./automationRenderPayload.ts";
import { automation, translationStatus } from "./aiaSuggestionFixtures.mjs";

const translationGroups = ["uiTranslation", "skills", "agents", "artifacts"];
const snapshot = (overrides = {}) => automation({
  instructions: translationStatus(),
  resourceTranslations: [],
  ...overrides,
});

test("V4: polling revisions and the four existing translation clocks do not redraw views", () => {
  const base = snapshot();
  const payload = automationRenderPayload(base);
  assert.equal(automationRenderPayload({ ...base, revision: base.revision + 1 }), payload);
  for (const group of translationGroups) {
    for (const updatedAt of [null, base[group].updatedAt + 1]) {
      assert.equal(automationRenderPayload({
        ...base, [group]: { ...base[group], updatedAt },
      }), payload, `${group}.updatedAt=${updatedAt}`);
    }
  }
});

test("V4: translation progress, cache counts, and errors still redraw every affected view", () => {
  const base = snapshot();
  const payload = automationRenderPayload(base);
  const changes = {
    phase: "running", total: 2, completed: 2, failed: 1, pending: 1, cached: 1,
    segmentTotal: 2, segmentCompleted: 2, segmentFailed: 1, segmentCached: 1,
    currentField: "description", lastError: "translation failed",
  };
  for (const group of translationGroups) {
    for (const [field, value] of Object.entries(changes)) {
      assert.notEqual(automationRenderPayload({
        ...base, [group]: { ...base[group], [field]: value },
      }), payload, `${group}.${field}`);
    }
  }
});

test("V4: catalog, settings, locale, providers, and resource translation changes remain visible", () => {
  const base = snapshot();
  const payload = automationRenderPayload(base);
  const changes = {
    resourceCatalogRevision: base.resourceCatalogRevision + 1,
    settings: { ...base.settings, systemProvider: "codex" },
    pendingLanguage: { code: "en", label: "English" },
    uiMessages: { title: "Translated title" },
    providers: [{ provider: "codex", displayName: "Codex" }],
    // Preserve the existing policy: instructions is part of the remaining payload,
    // so its clock is significant even though the four clocks above are ignored.
    instructions: { ...base.instructions, updatedAt: base.instructions.updatedAt + 1 },
    resourceTranslations: [{ menu: "skills", resourceId: "example", phase: "running" }],
  };
  for (const [field, value] of Object.entries(changes)) {
    assert.notEqual(automationRenderPayload({ ...base, [field]: value }), payload, field);
  }
});

test("V4: comparing render payloads leaves the snapshot and its nested statuses untouched", () => {
  const input = snapshot();
  const before = structuredClone(input);
  for (const value of Object.values(input)) {
    if (value && typeof value === "object") Object.freeze(value);
  }
  Object.freeze(input);
  const first = automationRenderPayload(input);
  assert.equal(automationRenderPayload(input), first);
  assert.deepEqual(input, before);
});
