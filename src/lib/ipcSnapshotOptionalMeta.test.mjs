import assert from "node:assert/strict";
import test from "node:test";

import { managerSnapshotSyncWithDefaults, sessionMetaWithDefaults } from "./ipcSnapshot.ts";

const bookmark = { id: "b1", messageKey: "m1", label: "읽던 자리", createdAt: 1 };

test("V2/V4 기본값이 없는 선택 메타(로컬 연결·읽던 자리)는 실려 온 그대로 남는다", () => {
  const meta = sessionMetaWithDefaults({ localConnectionId: "conn-a", bookmarks: [bookmark] });
  assert.equal(meta.localConnectionId, "conn-a");
  assert.deepEqual(meta.bookmarks, [bookmark]);
  // 명시적인 null 도 "기본 연결"이라는 값이라 지우지 않는다.
  assert.equal(sessionMetaWithDefaults({ localConnectionId: null }).localConnectionId, null);
});

test("V2/V4 실리지 않은 선택 메타는 키를 만들지 않고, 배열이 아닌 읽던 자리는 버린다", () => {
  const meta = sessionMetaWithDefaults({ favorite: true });
  assert.equal("localConnectionId" in meta, false);
  assert.equal("bookmarks" in meta, false);
  assert.equal("bookmarks" in sessionMetaWithDefaults({ bookmarks: "b1" }), false);
});

test("V2/V4 증분 동기화의 바뀐 세션도 선택 메타를 잃지 않는다", () => {
  const sync = managerSnapshotSyncWithDefaults({
    kind: "delta",
    dashboard: { weekly: [], recent: [] },
    changedSessions: [{ id: "s1", meta: { localConnectionId: "conn-b", bookmarks: [bookmark] } }],
  });
  assert.equal(sync.changedSessions[0].meta.localConnectionId, "conn-b");
  assert.deepEqual(sync.changedSessions[0].meta.bookmarks, [bookmark]);
});
