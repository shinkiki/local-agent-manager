import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildQueue,
  commitItemId,
  findingId,
  ledgerIndex,
  moduleItemId,
  pickItem,
} from "./codeReviewQueue.ts";

const NOW = 1_791_200_000;
const hoursAgo = (hours) => NOW - hours * 3600;

test("the same commit yields the same item id however it was written down", () => {
  const full = "539927cb1f2e4a5b6c7d8e9f0a1b2c3d4e5f6071";
  assert.equal(commitItemId(full), "C-539927cb1f2e");
  assert.equal(commitItemId(full.toUpperCase()), "C-539927cb1f2e");
  assert.equal(commitItemId("  539927cb1f2e  "), "C-539927cb1f2e");
  assert.equal(commitItemId("539927cb1f2e4a5b"), "C-539927cb1f2e");
});

test("something that is not a commit hash is refused rather than given an id", () => {
  for (const bad of ["", "   ", "abc123", "origin/develop", "539927cz1f2e", null, undefined]) {
    assert.throws(() => commitItemId(bad), /커밋 해시/, JSON.stringify(bad));
  }
});

test("two module paths that slug alike still get different item ids", () => {
  // 꼬리표가 없으면 둘 다 `M-crates-agent-manager-core-src-chat-rs` 가 되어 한쪽이 영영 굶는다.
  const a = moduleItemId("crates/agent-manager-core/src/chat.rs");
  const b = moduleItemId("crates/agent-manager-core/src-chat.rs");
  assert.notEqual(a, b);
  assert.match(a, /^M-crates-agent-manager-core-src-chat-rs-[0-9a-f]{8}$/);
});

test("a module path is the module's identity, whatever separators it arrived with", () => {
  const unix = moduleItemId("src/lib/chat.ts");
  assert.equal(moduleItemId(String.raw`src\lib\chat.ts`), unix);
  assert.equal(moduleItemId("./src/lib/chat.ts"), unix);
  assert.equal(moduleItemId("  src/lib/chat.ts  "), unix);
  assert.throws(() => moduleItemId("   "), /비어 있다/);
});

test("the same defect found from two commits carries one fingerprint", () => {
  const first = findingId({ file: "crates/agent-manager-core/src/chat.rs", symbol: "run_turn", symptom: "턴 반납을 완료로 센다" });
  const second = findingId({ file: "crates/agent-manager-core/src/chat.rs", symbol: "run_turn", symptom: "  턴 반납을, 완료로 센다  " });
  assert.equal(first, second);

  const otherFile = findingId({ file: "crates/agent-manager-core/src/plan.rs", symbol: "run_turn", symptom: "턴 반납을 완료로 센다" });
  assert.notEqual(first, otherFile);
  assert.throws(() => findingId({ file: "a.rs", symptom: "" }), /파일과 증상/);
});

test("a ledger that lists the same item twice reports it instead of swallowing it", () => {
  const { reviewed, duplicates } = ledgerIndex([
    { itemId: "C-aaaaaaaaaaaa" },
    { itemId: "C-bbbbbbbbbbbb" },
    { itemId: "C-aaaaaaaaaaaa" },
    { itemId: "   " },
  ]);
  assert.deepEqual([...reviewed].sort(), ["C-aaaaaaaaaaaa", "C-bbbbbbbbbbbb"]);
  assert.deepEqual(duplicates, ["C-aaaaaaaaaaaa"]);
});

test("reviewed items never come back onto the queue", () => {
  const report = buildQueue({
    now: NOW,
    commits: [
      { hash: "aaaaaaaaaaaa1111", timestamp: hoursAgo(1), subject: "새 커밋" },
      { hash: "bbbbbbbbbbbb2222", timestamp: hoursAgo(2), subject: "리뷰 끝난 커밋" },
    ],
    modules: [{ path: "src/lib/chat.ts" }],
    ledger: [{ itemId: commitItemId("bbbbbbbbbbbb2222") }, { itemId: moduleItemId("src/lib/chat.ts") }],
  });
  assert.deepEqual(report.items.map((item) => item.itemId), [commitItemId("aaaaaaaaaaaa1111")]);
  assert.equal(report.remaining, 1);
  assert.equal(report.counts.reviewed, 2);
});

test("the same commit listed twice takes one slot, not two", () => {
  const report = buildQueue({
    now: NOW,
    commits: [
      { hash: "aaaaaaaaaaaa1111", timestamp: hoursAgo(1) },
      { hash: "AAAAAAAAAAAA1111", timestamp: hoursAgo(1) },
    ],
  });
  assert.equal(report.remaining, 1);
});

test("commits are newest first and modules follow, so fresh defects are seen first", () => {
  const report = buildQueue({
    now: NOW,
    commits: [
      { hash: "cccccccccccc3333", timestamp: hoursAgo(5), subject: "오래된" },
      { hash: "aaaaaaaaaaaa1111", timestamp: hoursAgo(1), subject: "최신" },
    ],
    modules: [
      { path: "src/lib/b.ts", order: 2 },
      { path: "src/lib/a.ts", order: 1 },
    ],
  });
  assert.deepEqual(report.items.map((item) => item.title), ["최신", "오래된", "src/lib/a.ts", "src/lib/b.ts"]);
  assert.deepEqual(report.counts, { commit: 2, module: 2, expired: 0, reviewed: 0 });
});

test("a commit older than the window drops out of the queue and is counted as expired", () => {
  const report = buildQueue({
    now: NOW,
    commitWindowDays: 7,
    commits: [
      { hash: "aaaaaaaaaaaa1111", timestamp: hoursAgo(24 * 6) },
      { hash: "dddddddddddd4444", timestamp: hoursAgo(24 * 8) },
    ],
  });
  assert.deepEqual(report.items.map((item) => item.itemId), [commitItemId("aaaaaaaaaaaa1111")]);
  assert.equal(report.counts.expired, 1);
  assert.equal(report.remaining, 1);
});

test("duplicate commits older than the window are counted as expired only once", () => {
  const report = buildQueue({
    now: NOW,
    commitWindowDays: 7,
    commits: [
      { hash: "dddddddddddd4444", timestamp: hoursAgo(24 * 8) },
      { hash: "DDDDDDDDDDDD4444", timestamp: hoursAgo(24 * 8) },
      { hash: "dddddddddddd4444", timestamp: hoursAgo(24 * 9) },
    ],
  });
  assert.equal(report.counts.expired, 1);
  assert.equal(report.remaining, 0);
});

test("picking skips what another lane already holds", () => {
  const items = [
    { itemId: "C-aaaaaaaaaaaa", kind: "commit", ref: "a", title: "a" },
    { itemId: "C-bbbbbbbbbbbb", kind: "commit", ref: "b", title: "b" },
  ];
  assert.equal(pickItem(items, []).itemId, "C-aaaaaaaaaaaa");
  assert.equal(pickItem(items, ["C-aaaaaaaaaaaa"]).itemId, "C-bbbbbbbbbbbb");
  assert.equal(pickItem(items, ["C-aaaaaaaaaaaa", "C-bbbbbbbbbbbb"]), null);
  assert.equal(pickItem([], []), null);
});

test("an empty queue is zero remaining, not a crash", () => {
  const report = buildQueue({ now: NOW });
  assert.deepEqual(report.items, []);
  assert.equal(report.remaining, 0);
  assert.deepEqual(report.ledgerDuplicates, []);
  assert.throws(() => buildQueue({ now: "어제" }), /초 단위 숫자/);
});

// 장부 파일은 회차가 손으로 쓴다. notes 에 정규식을 적다가 `\b`·`\d` 를 그대로 흘리면
// JSON 이 깨지는데, 러너는 깨진 본문을 이름만으로 세고 넘어가(code-review-queue.mjs 의
// catch) 아무 소리도 나지 않는다. 그래서 여기서 막는다.
test("장부 파일은 전부 JSON 으로 읽히고 이름과 본문의 id 가 같다", () => {
  const root = fileURLToPath(new URL("../../docs/code-review", import.meta.url));
  for (const [dir, key] of [["reviewed", "itemId"], ["findings", "findingId"]]) {
    let names;
    try {
      names = readdirSync(join(root, dir));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(join(root, dir, name), "utf8");
      let body;
      assert.doesNotThrow(() => { body = JSON.parse(text); }, `${dir}/${name} 이 JSON 으로 읽히지 않는다`);
      assert.equal(body[key], name.slice(0, -".json".length), `${dir}/${name} 의 ${key} 가 파일 이름과 다르다`);
    }
  }
});
