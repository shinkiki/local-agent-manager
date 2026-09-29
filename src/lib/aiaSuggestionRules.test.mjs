import assert from "node:assert/strict";
import test from "node:test";
import { dismissAiaSuggestion, emptyAiaSuggestionHistory } from "./aiaSuggestionHistory.ts";
import { evaluateAiaSuggestions } from "./aiaSuggestions.ts";
import {
  NOW,
  account,
  accountSnapshot,
  attention,
  attentionItem,
  automation,
  catalog,
  definition,
  evaluation,
  manager,
  schedulerSnapshot,
  translationStatus,
} from "./aiaSuggestionFixtures.mjs";

test("interrupted reminders honor delay, expiry, actual interruption and attended standard profile", () => {
  const interruptedDefinition = definition("interruptedSessionReminder");
  const valid = attentionItem("valid");
  const items = [
    valid,
    attentionItem("too-soon", { createdAt: NOW - 29 * 60_000 }),
    attentionItem("expired", { createdAt: NOW - 8 * 24 * 60 * 60_000 }),
    attentionItem("unattended", { unattended: true }),
    attentionItem("scheduled", { profile: "scheduled" }),
    attentionItem("aia", { profile: "aia_system" }),
    attentionItem("mere-failure", { detail: "network" }),
  ];
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(interruptedDefinition), attention: attention(items),
  }));
  assert.deepEqual(suggestions.map((item) => item.targetId), [valid.id]);
});

test("a newer running or completed item suppresses an interrupted reminder by chat or provider session", () => {
  const interruptedDefinition = definition("interruptedSessionReminder");
  const byChat = attentionItem("by-chat");
  const byProvider = attentionItem("by-provider");
  const items = [
    byChat,
    byProvider,
    attentionItem("resume-chat", { chatId: byChat.chatId, providerSessionId: "different", kind: "running", createdAt: byChat.createdAt + 1 }),
    attentionItem("resume-provider", { chatId: "different", providerSessionId: byProvider.providerSessionId, kind: "completed", createdAt: byProvider.createdAt + 1 }),
  ];
  assert.equal(evaluateAiaSuggestions(evaluation({
    catalog: catalog(interruptedDefinition), attention: attention(items),
  })).length, 0);
});

test("operational definitions evaluate CLI, account, scheduler and translation facts", () => {
  const definitions = [
    definition("providerCliMissing"),
    definition("accountAuthError"),
    definition("accountAutoSwitchMissing"),
    definition("schedulerPaused"),
    definition("scheduleRunFailed"),
    definition("translationFailed"),
    definition("featureTip", { parameters: { featureName: "voice" } }),
  ];
  const accounts = accountSnapshot(
    account("broken", { authStatus: "error", isActive: true, usage: { status: "ok", windows: [{ label: "weekly", usedPercent: 91, resetsAt: null }], updatedAt: NOW, error: null } }),
    account("standby"),
    account("standby-2"),
  );
  const scheduler = schedulerSnapshot(
    true,
    [{ id: "run", scheduleId: "schedule", status: "failed", scheduledFor: NOW - 1, startedAt: NOW - 1, finishedAt: NOW, recoveryError: null }],
    [{ id: "schedule", name: "Daily report" }],
  );
  const provider = { provider: "claude", displayName: "Claude", cli: { detected: false, path: null }, history: { detected: true, path: "/history" } };
  const auto = automation({ providers: [provider], skills: translationStatus({ phase: "error", failed: 1 }) });
  const suggestions = evaluateAiaSuggestions(evaluation({
    catalog: catalog(...definitions), manager: manager([], [provider]), accounts, scheduler, automation: auto,
  }));
  assert.deepEqual(new Set(suggestions.map((item) => item.kind)), new Set(definitions.map((item) => item.kind)));
});

test("retired usage definitions produce no suggestion even above the threshold", () => {
  const accounts = accountSnapshot(account("hot", {
    isActive: true,
    usage: { status: "ok", windows: [{ label: "weekly", usedPercent: 99, resetsAt: null }], updatedAt: NOW, error: null },
  }));
  const usage = definition("accountUsageThreshold", { parameters: { thresholdPercent: 70 } });
  assert.equal(evaluateAiaSuggestions(evaluation({ catalog: catalog(usage), accounts })).length, 0);
});

test("skill change trigger proposes a review immediately and honors limits and dismissal", () => {
  const changes = [
    { key: "review", name: "코드 검토", previousDigest: "d1", digest: "d2", detectedAt: NOW - 1_000 },
    { key: "release", name: "배포", previousDigest: "r1", digest: "r2", detectedAt: NOW - 2_000 },
    { key: "old", name: "만료", previousDigest: "o1", digest: "o2", detectedAt: NOW - 25 * 60 * 60_000 },
  ];
  const input = evaluation({
    catalog: catalog(definition("skillContentChanged", {
      titleTemplate: "{skillName} 스킬 내용이 바뀌었습니다",
      detailTemplate: "검토할 수 있습니다",
      promptTemplate: "{skillName} 변경을 검토해줘",
      parameters: { expiresHours: 24, maxResults: 3 },
      rearm: { afterResolved: true },
    })),
    skillChanges: changes,
  });

  const suggestions = evaluateAiaSuggestions(input);
  // 임계값이나 지연 없이 최신 변경부터 바로 제안하고, 만료된 변경은 제외한다.
  assert.deepEqual(suggestions.map((suggestion) => suggestion.targetId), ["review", "release"]);
  assert.equal(suggestions[0].title, "코드 검토 스킬 내용이 바뀌었습니다");
  assert.equal(suggestions[0].prompt, "코드 검토 변경을 검토해줘");

  const limited = evaluateAiaSuggestions({
    ...input,
    catalog: catalog(definition("skillContentChanged", { parameters: { maxResults: 1 } })),
  });
  assert.equal(limited.length, 1);
  assert.equal(limited[0].targetId, "review");

  // 이력 기반 숨기기도 같은 변경으로는 다시 뜨지 않게 막는다.
  const dismissed = dismissAiaSuggestion(emptyAiaSuggestionHistory(), suggestions[0], NOW);
  const remaining = evaluateAiaSuggestions({ ...input, history: dismissed });
  assert.deepEqual(remaining.map((suggestion) => suggestion.targetId), ["release"]);
});
