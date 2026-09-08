import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SESSION_FOLDER_DEPTH,
  canAddChildFolder,
  folderFilterShows,
  folderParentOptions,
  folderPathLabel,
  folderSubtreeIds,
  hiddenByFolders,
  hiddenFolderIds,
  recountSessionFolders,
  visibleFolderSubtreeIds,
} from "./sessionFolders.ts";

function folder(id, name, parentId, sortOrder = 0, hidden = false) {
  return { id, name, color: "#51e97d", sortOrder, parentId, hidden, depth: 0, sessionCount: 0, totalSessionCount: 0 };
}

function session(id, folderIds) {
  return { source: "codex", id, meta: { folderIds } };
}

/**
 * 이 파일의 트리 질의 테스트가 거듭 쓰는 3단계 사슬(업무 > 리뷰 > 긴급). 같은 리터럴을
 * 테스트마다 다시 적으면 단계 판정을 손볼 때 어떤 트리가 무엇을 검증하는지 흩어진다.
 * 각 테스트가 실제로 다른 것은 중간 단계를 숨겼는지와 곁가지 하나뿐이라 그 둘만 받는다.
 */
function workFolders({ childHidden = false, extra = null } = {}) {
  const built = [
    folder("root", "업무", null, 0),
    folder("child", "리뷰", "root", 0, childHidden),
    folder("grandchild", "긴급", "child", 0),
  ];
  if (extra) built.push(extra);
  return built;
}

test("recountSessionFolders는 트리 순서와 하위 합계를 채운다", () => {
  const folders = [
    folder("child", "리뷰", "root", 0),
    folder("root", "업무", null, 0),
    folder("grandchild", "긴급", "child", 0),
    folder("other", "보관", null, 1),
  ];
  const sessions = [
    session("s1", ["root"]),
    session("s2", ["child", "grandchild"]),
    session("s3", ["other"]),
  ];

  const recounted = recountSessionFolders(folders, sessions);

  assert.deepEqual(
    recounted.map((item) => [item.name, item.depth, item.sessionCount, item.totalSessionCount]),
    [
      ["업무", 0, 1, 2],
      ["리뷰", 1, 1, 1],
      ["긴급", 2, 1, 1],
      ["보관", 0, 1, 1],
    ],
  );
});

test("recountSessionFolders는 없어진 상위 참조와 순환을 최상위로 되돌린다", () => {
  const folders = [
    folder("orphan", "고아", "missing"),
    folder("a", "순환1", "b"),
    folder("b", "순환2", "a"),
  ];

  const recounted = recountSessionFolders(folders, []);

  assert.equal(recounted.length, 3);
  assert.ok(recounted.every((item) => item.parentId === null));
  assert.ok(recounted.every((item) => item.depth === 0));
});

test("folderSubtreeIds는 자신과 모든 하위를 모은다", () => {
  const folders = workFolders({ extra: folder("other", "보관", null) });

  assert.deepEqual([...folderSubtreeIds(folders, "root")].sort(), ["child", "grandchild", "root"]);
  assert.deepEqual([...folderSubtreeIds(folders, "other")], ["other"]);
});

test("folderPathLabel은 최상위부터 이어 붙인다", () => {
  const folders = [
    folder("root", "업무", null),
    folder("child", "리뷰", "root"),
  ];

  assert.equal(folderPathLabel(folders, "child"), "업무 / 리뷰");
  assert.equal(folderPathLabel(folders, "root"), "업무");
  assert.equal(folderPathLabel(folders, "missing"), "");
});

test("folderParentOptions는 자기 하위 트리와 단계 초과 후보를 뺀다", () => {
  const chain = [];
  for (let level = 0; level < MAX_SESSION_FOLDER_DEPTH; level += 1) {
    chain.push(folder(`level-${level}`, `${level + 1}단계`, level === 0 ? null : `level-${level - 1}`));
  }
  const folders = recountSessionFolders([...chain, folder("loose", "독립", null, 9)], []);

  const options = folderParentOptions(folders, "level-1").map((item) => item.id);
  // level-1 아래로 3단계가 더 있으므로 최상위(level-0)와 독립 폴더만 남는다.
  assert.deepEqual(options.sort(), ["level-0", "loose"]);

  const deepest = folders.find((item) => item.id === `level-${MAX_SESSION_FOLDER_DEPTH - 1}`);
  assert.equal(canAddChildFolder(deepest), false);
  assert.equal(canAddChildFolder(folders.find((item) => item.id === "level-0")), true);
});

test("상위 후보는 가지가 갈린 트리에서도 가장 깊은 가지 높이로 걸러진다", () => {
  const folders = recountSessionFolders([
    folder("top", "최상위", null),
    folder("shallow", "얕은 가지", "top"),
    folder("deep-1", "깊은 가지", "top", 1),
    folder("deep-2", "깊은 가지 하위", "deep-1"),
    folder("other", "독립", null, 9),
  ], []);

  // top 밑으로 3단계(deep-1 → deep-2)가 더 있으므로 최상위 자리만 남는다.
  assert.deepEqual(folderParentOptions(folders, "top").map((item) => item.id).sort(), ["other"]);
  // 얕은 가지는 잎이라 높이가 0이고, 남은 단계 안에서 다른 가지 밑으로도 옮길 수 있다.
  assert.deepEqual(
    folderParentOptions(folders, "shallow").map((item) => item.id).sort(),
    ["deep-1", "deep-2", "other", "top"],
  );
});

test("숨긴 폴더는 자기 합계는 지키고 상위 합계에서만 빠진다", () => {
  const folders = workFolders({ childHidden: true, extra: folder("sibling", "보관", "root", 1) });
  const sessions = [
    session("s1", ["root"]),
    session("s2", ["child"]),
    session("s3", ["grandchild"]),
    session("s4", ["sibling"]),
  ];

  const recounted = recountSessionFolders(folders, sessions);
  const byId = new Map(recounted.map((item) => [item.id, item]));

  // 업무는 자기 1건 + 보관 1건만 센다. 숨긴 리뷰와 그 아래 긴급은 빠진다.
  assert.equal(byId.get("root").totalSessionCount, 2);
  assert.equal(byId.get("child").sessionCount, 1);
  assert.equal(byId.get("child").totalSessionCount, 2);
});

test("hiddenFolderIds는 숨김을 하위로 잇는다", () => {
  const folders = workFolders({ childHidden: true, extra: folder("other", "보관", null) });

  assert.deepEqual([...hiddenFolderIds(folders)].sort(), ["child", "grandchild"]);
});

test("visibleFolderSubtreeIds는 숨긴 하위에서 멈추고 고른 폴더 자신은 담는다", () => {
  const folders = workFolders({ childHidden: true });

  // 상위를 고르면 숨긴 하위는 딸려 오지 않는다.
  assert.deepEqual([...visibleFolderSubtreeIds(folders, "root")], ["root"]);
  // 숨긴 폴더를 직접 고르면 그 안이 열린다.
  assert.deepEqual([...visibleFolderSubtreeIds(folders, "child")].sort(), ["child", "grandchild"]);
  // 삭제 범위는 숨김과 무관하게 트리 전체다.
  assert.deepEqual([...folderSubtreeIds(folders, "root")].sort(), ["child", "grandchild", "root"]);
});

test("hiddenByFolders는 숨긴 폴더에만 담긴 세션만 뺀다", () => {
  const hidden = new Set(["child"]);

  assert.equal(hiddenByFolders(["child"], hidden), true);
  // 보이는 폴더에도 담겨 있으면 그 폴더에서 계속 봐야 한다.
  assert.equal(hiddenByFolders(["child", "root"], hidden), false);
  // 미분류는 폴더 숨김과 무관하다.
  assert.equal(hiddenByFolders([], hidden), false);
  // 없어진 폴더 참조만 남은 세션도 그대로 보인다.
  assert.equal(hiddenByFolders(["missing"], hidden), false);
});

test("folderFilterShows는 목록 폴더 필터와 같은 규칙으로 판정한다", () => {
  const folders = workFolders({ childHidden: true });

  // 전체 목록에서는 숨긴 폴더에만 담긴 세션이 빠진다.
  assert.equal(folderFilterShows(folders, "all", ["child"]), false);
  assert.equal(folderFilterShows(folders, "all", ["root"]), true);
  assert.equal(folderFilterShows(folders, "all", []), true);
  // 숨긴 폴더를 직접 고르면 그 안과 하위가 열린다.
  assert.equal(folderFilterShows(folders, "child", ["child"]), true);
  assert.equal(folderFilterShows(folders, "child", ["grandchild"]), true);
  // 상위 폴더를 골라도 숨긴 하위는 딸려 오지 않는다.
  assert.equal(folderFilterShows(folders, "root", ["child"]), false);
  // 미분류는 어디에도 담기지 않은 세션만이다.
  assert.equal(folderFilterShows(folders, "unfiled", []), true);
  assert.equal(folderFilterShows(folders, "unfiled", ["root"]), false);
});

test("파생 자료를 재사용해도 다른 목록에는 앞선 결과가 새지 않는다", () => {
  const hiddenTree = workFolders({ childHidden: true });
  const visibleTree = workFolders();

  // 같은 배열을 거듭 물어도 답이 흔들리지 않는다.
  assert.deepEqual(hiddenFolderIds(hiddenTree), new Set(["child", "grandchild"]));
  assert.deepEqual(hiddenFolderIds(hiddenTree), new Set(["child", "grandchild"]));
  // 내용이 다른 새 배열은 앞선 결과를 물려받지 않고 다시 계산된다.
  assert.deepEqual(hiddenFolderIds(visibleTree), new Set());
  assert.deepEqual(visibleFolderSubtreeIds(visibleTree, "root"), new Set(["root", "child", "grandchild"]));
  assert.deepEqual(visibleFolderSubtreeIds(hiddenTree, "root"), new Set(["root"]));

  // 경로 문구는 다듬지 않은 상위 참조를 그대로 읽는다 — 트리 질의와 색인을 섞지 않는다.
  assert.equal(folderPathLabel(hiddenTree, "grandchild"), "업무 / 리뷰 / 긴급");
  assert.equal(folderPathLabel(visibleTree, "grandchild"), "업무 / 리뷰 / 긴급");
});

test("트리 파생값을 캐시해도 세션 수 재계산이 거듭 부를 때마다 같다", () => {
  const folders = workFolders();
  const sessions = [session("a", ["child"]), session("b", ["grandchild"])];

  // 전위 순회 순서를 트리에 매달아 두므로, 그 배열을 뒤집어 쓰는 하위 합계 계산이
  // 캐시본을 제자리에서 건드리면 두 번째 호출부터 단계와 합계가 어긋난다.
  const first = recountSessionFolders(folders, sessions);
  const second = recountSessionFolders(folders, sessions);
  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map(({ id, depth, sessionCount, totalSessionCount }) => [id, depth, sessionCount, totalSessionCount]),
    [["root", 0, 0, 2], ["child", 1, 1, 2], ["grandchild", 2, 1, 1]],
  );
});
