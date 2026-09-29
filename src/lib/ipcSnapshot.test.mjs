import assert from "node:assert/strict";
import test from "node:test";

import {
  managerSnapshotSyncWithDefaults,
  managerSnapshotWithDefaults,
  sessionMetaWithDefaults,
  sourceCountsWithDefaults,
  sourceTotalsWithDefaults,
} from "./ipcSnapshot.ts";

test("세션 메타의 빠진 필드를 기본값으로 채운다", () => {
  assert.deepEqual(sessionMetaWithDefaults(null), {
    favorite: false,
    hidden: false,
    note: null,
    customTitle: null,
    folderIds: [],
    reasoningEffort: null,
    mode: null,
    approvalMode: null,
    creationAccountId: null,
    boundAccountId: null,
    pinnedAccountId: null,
    origin: null,
    handoffOrigin: null,
    handoffTargets: [],
  });
  // 백엔드가 실어 보낸 출처·인계 값은 그대로 남아야 한다. 떨어뜨리면 세션 목록의 반복
  // 요청 필터와 인계 기록 구역이 값을 못 본다.
  assert.deepEqual(
    sessionMetaWithDefaults({ origin: { kind: "schedule", scheduleId: "s1" } }).origin,
    { kind: "schedule", scheduleId: "s1" },
  );
  assert.deepEqual(sessionMetaWithDefaults({ favorite: true, folderIds: ["a"] }).folderIds, ["a"]);
  // 배열이 아닌 값이 저장돼 있어도 목록 렌더가 깨지지 않도록 빈 배열로 떨어진다.
  assert.deepEqual(sessionMetaWithDefaults({ folderIds: "a" }).folderIds, []);
});

test("공급자별 집계는 빠진 공급자를 0으로 둔다", () => {
  assert.deepEqual(sourceCountsWithDefaults({ codex: 3 }), { claude: 0, codex: 3, antigravity: 0, local: 0 });
  assert.deepEqual(sourceTotalsWithDefaults(null), { claude: 0, codex: 0, antigravity: 0, local: 0, total: 0 });
  assert.equal(sourceTotalsWithDefaults({ total: 7 }).total, 7);
});

test("스냅샷의 세션 목록과 대시보드 최근 목록에 같은 규칙이 적용된다", () => {
  const snapshot = managerSnapshotWithDefaults({
    sessions: [{ source: "claude", id: "a", meta: { favorite: true } }],
    dashboard: {
      sessionsBySource: { claude: 1 },
      tokens: { claude: 2 },
      disk: {},
      weekly: [{ week: "2026-W01", claude: 5 }],
      recent: [{ source: "codex", id: "b", meta: null }],
    },
  });

  assert.equal(snapshot.sessionCatalogRevision, 0);
  assert.equal(snapshot.resourceCatalogRevision, 0);
  assert.deepEqual(snapshot.folders, []);
  assert.equal(snapshot.sessions[0].meta.favorite, true);
  assert.equal(snapshot.sessions[0].meta.hidden, false);
  assert.equal(snapshot.dashboard.recent[0].meta.customTitle, null);
  assert.deepEqual(snapshot.dashboard.sessionsBySource, { claude: 1, codex: 0, antigravity: 0, local: 0 });
  assert.deepEqual(snapshot.dashboard.disk, { claude: 0, codex: 0, antigravity: 0, local: 0, total: 0 });
  // 주간 행은 집계 외 필드(week)를 그대로 유지한 채 공급자 칸만 채워진다.
  assert.deepEqual(snapshot.dashboard.weekly[0], { week: "2026-W01", claude: 5, codex: 0, antigravity: 0, local: 0 });
});

test("managerSnapshotSyncWithDefaults는 전체 및 증분 동기화에 공통 기본값을 채운다", () => {
  const fullSync = managerSnapshotSyncWithDefaults({
    kind: "full",
    sessions: [{ source: "claude", id: "s1", meta: null }],
    dashboard: {
      sessionsBySource: {},
      tokens: {},
      disk: {},
      weekly: [],
      recent: [],
    },
  });
  assert.equal(fullSync.kind, "full");
  assert.equal(fullSync.sessionCatalogRevision, 0);
  assert.equal(fullSync.resourceCatalogRevision, 0);
  assert.deepEqual(fullSync.folders, []);
  assert.equal(fullSync.sessions[0].meta.favorite, false);

  const deltaSync = managerSnapshotSyncWithDefaults({
    kind: "delta",
    changedSessions: [{ source: "codex", id: "s2", meta: null }],
    removedSessions: [{ source: "claude", id: "s3" }],
    dashboard: {
      sessionsBySource: {},
      tokens: {},
      disk: {},
      weekly: [],
      recent: [],
    },
  });
  assert.equal(deltaSync.kind, "delta");
  assert.equal(deltaSync.sessionCatalogRevision, 0);
  assert.equal(deltaSync.resourceCatalogRevision, 0);
  assert.deepEqual(deltaSync.folders, []);
  assert.equal(deltaSync.changedSessions[0].meta.favorite, false);
  assert.deepEqual(deltaSync.removedSessions, [{ source: "claude", id: "s3" }]);
});

