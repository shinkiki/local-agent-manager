import assert from "node:assert/strict";
import test from "node:test";
import {
  bucketFor,
  compareRankDesc,
  dedupeByKey,
  joinParts,
  joinSummary,
  maxByScore,
  SUMMARY_SEPARATOR,
  uniqueInOrder,
} from "./sequence.ts";

test("uniqueInOrder는 처음 나온 것만 남기고 순서를 지킨다", () => {
  assert.deepEqual(uniqueInOrder(["codex", "claude", "codex", "antigravity"]), [
    "codex",
    "claude",
    "antigravity",
  ]);
  assert.deepEqual(uniqueInOrder([]), []);
});

test("uniqueInOrder는 원본을 고치지 않고 새 배열을 돌려준다", () => {
  const values = ["a", "a", "b"];

  const unique = uniqueInOrder(values);

  assert.notEqual(unique, values);
  assert.deepEqual(values, ["a", "a", "b"]);
});

test("compareRankDesc는 앞자리가 갈리는 곳에서 큰 쪽을 앞으로 보낸다", () => {
  assert.ok(compareRankDesc([2, 0], [1, 9]) < 0);
  assert.ok(compareRankDesc([1, 9], [2, 0]) > 0);
  // 앞자리가 같을 때만 다음 자리를 본다.
  assert.ok(compareRankDesc([1, 9], [1, 3]) < 0);
  assert.equal(compareRankDesc([1, 3], [1, 3]), 0);
});

test("compareRankDesc는 무한대 자리에서도 부호를 잃지 않는다", () => {
  const none = Number.NEGATIVE_INFINITY;

  // 뺄셈으로 적으면 NaN이 되어 정렬이 흔들리던 자리다.
  assert.equal(compareRankDesc([none, 2], [none, 2]), 0);
  assert.ok(compareRankDesc([none, 5], [none, 1]) < 0);
  assert.ok(compareRankDesc([none, 1], [0, 9]) > 0);
});

test("compareRankDesc로 정렬하면 순위표 순서가 그대로 나온다", () => {
  const rows = [{ rank: [1, 1] }, { rank: [3, 0] }, { rank: [1, 7] }];

  assert.deepEqual(
    [...rows].sort((left, right) => compareRankDesc(left.rank, right.rank)).map((row) => row.rank),
    [[3, 0], [1, 7], [1, 1]],
  );
});

test("maxByScore는 점수가 가장 큰 첫 항목을 고르고 null 점수는 제외한다", () => {
  const values = [
    { name: "제외", score: null },
    { name: "먼저", score: 3 },
    { name: "동률", score: 3 },
    { name: "작음", score: 1 },
  ];
  assert.equal(maxByScore(values, (value) => value.score)?.name, "먼저");
  assert.equal(maxByScore(values, () => null), null);
});

test("joinParts는 거짓값 조각을 걷어내고 남은 것만 구분자로 잇는다", () => {
  assert.equal(
    joinParts(["세션 3건", false && "실체 회수", null, "실패 1건", undefined], " · "),
    "세션 3건 · 실패 1건",
  );
  // 빈 문자열도 넣을 것이 없는 조각이라 구분자를 남기지 않는다.
  assert.equal(joinParts(["앞", "", "뒤"], " · "), "앞 · 뒤");
});

test("joinParts는 남는 조각이 없으면 빈 문자열이다", () => {
  assert.equal(joinParts([], " · "), "");
  assert.equal(joinParts([false, null, undefined, ""], "\n\n"), "");
  // 하나만 남으면 구분자가 붙지 않는다.
  assert.equal(joinParts([false, "하나"], "\n\n"), "하나");
});

test("joinSummary는 카드 요약 구분자로 남은 조각만 잇는다", () => {
  assert.equal(SUMMARY_SEPARATOR, " · ");
  assert.equal(
    joinSummary(["세션 3건", false && "실체 회수", null, undefined, "실패 1건"]),
    "세션 3건 · 실패 1건",
  );
  // 남는 조각이 하나면 구분자가 붙지 않아, 사유가 없는 표기가 그대로 머리말만 남는다.
  assert.equal(joinSummary(["워크플로 주간보고 v3", null]), "워크플로 주간보고 v3");
  assert.equal(joinSummary([]), "");
});

test("bucketFor는 없는 키만 만들고 있는 값은 그대로 돌려준다", () => {
  const buckets = new Map();
  let created = 0;
  const first = bucketFor(buckets, "a", () => { created += 1; return []; });
  first.push(1);
  bucketFor(buckets, "a", () => { created += 1; return []; }).push(2);
  assert.equal(created, 1);
  assert.deepEqual(buckets.get("a"), [1, 2]);
});

test("bucketFor는 값이 undefined인 키를 없는 키로 보지 않는다", () => {
  const buckets = new Map([["a", undefined]]);
  assert.equal(bucketFor(buckets, "a", () => "만듦"), undefined);
  assert.equal(bucketFor(buckets, "b", () => "만듦"), "만듦");
});

test("dedupeByKey는 기본으로 먼저 온 항목을 남기고 최초 자리를 지킨다", () => {
  const values = [
    { key: "a", tag: "첫 a" },
    { key: "b", tag: "b" },
    { key: "a", tag: "나중 a" },
  ];

  assert.deepEqual(dedupeByKey(values, (value) => value.key), [
    { key: "a", tag: "첫 a" },
    { key: "b", tag: "b" },
  ]);
});

test("dedupeByKey는 prefers에 걸린 항목으로 값만 바꾸고 자리는 그대로 둔다", () => {
  const values = [
    { key: "a", rank: 1 },
    { key: "b", rank: 9 },
    { key: "a", rank: 5 },
  ];

  assert.deepEqual(
    dedupeByKey(values, (value) => value.key, (candidate, current) => candidate.rank > current.rank),
    [{ key: "a", rank: 5 }, { key: "b", rank: 9 }],
  );
});

test("dedupeByKey는 원본을 고치지 않는다", () => {
  const values = [{ key: "a" }];

  const deduped = dedupeByKey(values, (value) => value.key);

  assert.notEqual(deduped, values);
  assert.equal(deduped[0], values[0]);
});
