import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAiaSkillChange,
  emptyAiaSkillChangeState,
  observeAiaSkillChanges,
  parseAiaSkillChangeState,
  serializeAiaSkillChangeState,
} from "./aiaSkillChanges.ts";
import { NOW, skillDigest } from "./aiaSuggestionFixtures.mjs";

test("skill change detection seeds a baseline first and then reports only real content changes", () => {
  const digests = [skillDigest("review", "d1"), skillDigest("release", "r1")];
  const seeded = observeAiaSkillChanges(emptyAiaSkillChangeState(), digests, NOW);
  assert.deepEqual(seeded.changes, []);
  assert.deepEqual(seeded.digests, { review: "d1", release: "r1" });

  // 내용이 그대로면 변경으로 보지 않는다.
  assert.deepEqual(observeAiaSkillChanges(seeded, digests, NOW + 1_000).changes, []);

  const changed = observeAiaSkillChanges(seeded, [skillDigest("review", "d2"), skillDigest("release", "r1")], NOW + 2_000);
  assert.equal(changed.changes.length, 1);
  assert.deepEqual(changed.changes[0], {
    key: "review", name: "review", previousDigest: "d1", digest: "d2", detectedAt: NOW + 2_000,
  });

  // 감지된 변경은 사용자가 내리기 전까지 같은 감지 시각으로 유지된다.
  const held = observeAiaSkillChanges(changed, [skillDigest("review", "d2"), skillDigest("release", "r1")], NOW + 3_000);
  assert.deepEqual(held.changes, changed.changes);

  // 연달아 바뀌면 검토 범위가 끊기지 않도록 첫 변경 이전 지문을 유지한다.
  const again = observeAiaSkillChanges(held, [skillDigest("review", "d3"), skillDigest("release", "r1")], NOW + 4_000);
  assert.equal(again.changes[0].previousDigest, "d1");
  assert.equal(again.changes[0].digest, "d3");

  // 만료된 변경과 사라진 스킬은 목록에서 내린다.
  assert.deepEqual(observeAiaSkillChanges(again, [skillDigest("review", "d3")], NOW + 4_000 + 24 * 60 * 60_000 + 1).changes, []);
  assert.deepEqual(observeAiaSkillChanges(again, [skillDigest("release", "r1")], NOW + 5_000).changes, []);

  assert.deepEqual(parseAiaSkillChangeState(serializeAiaSkillChangeState(again)), again);
  assert.deepEqual(parseAiaSkillChangeState("{\"schemaVersion\":2}"), emptyAiaSkillChangeState());
});

test("clearing a detected change keeps the baseline and returns the same state when nothing matches", () => {
  const changes = [
    { key: "review", name: "코드 검토", previousDigest: "d1", digest: "d2", detectedAt: NOW - 1_000 },
    { key: "release", name: "배포", previousDigest: "r1", digest: "r2", detectedAt: NOW - 2_000 },
    { key: "old", name: "만료", previousDigest: "o1", digest: "o2", detectedAt: NOW - 25 * 60 * 60_000 },
  ];
  const cleared = clearAiaSkillChange({ schemaVersion: 1, digests: { review: "d2" }, changes }, "review");
  assert.deepEqual(cleared.changes.map((change) => change.key), ["release", "old"]);
  assert.deepEqual(cleared.digests, { review: "d2" });
  assert.equal(clearAiaSkillChange(cleared, "review"), cleared);
});
