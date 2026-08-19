import assert from "node:assert/strict";
import test from "node:test";
import { dedupeSessionSummaries, normalizeManagerSnapshot } from "./sessionCatalog.ts";

function session(overrides) {
  return {
    source: "claude",
    id: "session-1",
    title: "세션",
    sourceTitle: "세션",
    project: "project",
    cwd: "/workspace/project",
    startedAt: 1,
    updatedAt: 100,
    messageCount: 10,
    tokenTotal: null,
    tokenUsage: null,
    model: null,
    gitBranch: null,
    isSubagent: false,
    archived: false,
    readable: true,
    sizeBytes: 1000,
    filePath: "/a.jsonl",
    meta: { customTitle: null, hidden: false, favorite: false, folderIds: [] },
    ...overrides,
  };
}

test("the same source and session ID collapses to the newest, fullest entry", () => {
  const deduped = dedupeSessionSummaries([
    session({ updatedAt: 100, messageCount: 97, filePath: "/nfd.jsonl" }),
    session({ updatedAt: 200, messageCount: 102, filePath: "/nfc.jsonl" }),
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].messageCount, 102);
  assert.equal(deduped[0].filePath, "/nfc.jsonl");
});

test("different sessions and different sources are kept apart", () => {
  const deduped = dedupeSessionSummaries([
    session({ id: "session-1" }),
    session({ id: "session-2" }),
    session({ id: "session-1", source: "codex" }),
  ]);

  assert.deepEqual(
    deduped.map((item) => `${item.source}:${item.id}`),
    ["claude:session-1", "claude:session-2", "codex:session-1"],
  );
});

test("a full tie resolves by file path so the list order stays stable", () => {
  const deduped = dedupeSessionSummaries([
    session({ filePath: "/z.jsonl" }),
    session({ filePath: "/a.jsonl" }),
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].filePath, "/a.jsonl");
});

test("a snapshot without duplicates is returned unchanged", () => {
  const snapshot = {
    sessions: [session({ id: "session-1" }), session({ id: "session-2" })],
    dashboard: { recent: [session({ id: "session-1" })] },
  };

  assert.equal(normalizeManagerSnapshot(snapshot), snapshot);
});

test("snapshot normalization also cleans the dashboard recent list", () => {
  const snapshot = {
    sessions: [
      session({ updatedAt: 100, messageCount: 97, filePath: "/nfd.jsonl" }),
      session({ updatedAt: 200, messageCount: 102, filePath: "/nfc.jsonl" }),
    ],
    dashboard: {
      recent: [
        session({ updatedAt: 100, messageCount: 97, filePath: "/nfd.jsonl" }),
        session({ updatedAt: 200, messageCount: 102, filePath: "/nfc.jsonl" }),
      ],
    },
  };

  const normalized = normalizeManagerSnapshot(snapshot);

  assert.equal(normalized.sessions.length, 1);
  assert.equal(normalized.dashboard.recent.length, 1);
  assert.equal(normalized.dashboard.recent[0].messageCount, 102);
});
