import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSamples } from "../../local-llm-dev/finetune/export-feature-map.mjs";

const catalog = {
  read: [
    { operation: "get_app_status", description: "플랫폼과 공급자 CLI 상태", arguments: {} },
    { operation: "list_sessions", description: "세션 목록 조회", arguments: { limit: 20 } },
  ],
  execute: [{ operation: "patch_session_meta", description: "세션 메타 수정", arguments: { sessionId: "ses_x", patch: {} } }],
};

test("카탈로그의 모든 작업을 한 번씩 덮는다", () => {
  const samples = buildSamples(catalog);
  const calls = samples.filter((s) => s.kind === "call");
  const names = samples.filter((s) => s.kind === "name");
  assert.deepEqual(calls.map((s) => s.operation).sort(), ["get_app_status", "list_sessions", "patch_session_meta"]);
  assert.equal(names.length, 3, "작업마다 이름 풀이도 하나씩 낸다");
  assert.equal(calls.find((s) => s.operation === "list_sessions").tool, "system_read");
  assert.equal(calls.find((s) => s.operation === "patch_session_meta").tool, "system_execute");
});

test("이름 풀이는 조회·변경과 인자 이름을 적는다", () => {
  const byOperation = Object.fromEntries(buildSamples(catalog).filter((s) => s.kind === "name").map((s) => [s.operation, s]));
  assert.match(byOperation.list_sessions.answer, /조회 작업이다/);
  assert.match(byOperation.list_sessions.answer, /인자는 limit/);
  assert.match(byOperation.patch_session_meta.answer, /변경 작업이다/);
  assert.match(byOperation.get_app_status.answer, /인자는 없다/);
});

test("카탈로그에 없는 일은 없다고 답하는 표본으로 넣는다", () => {
  const absent = buildSamples(catalog).filter((s) => s.kind === "absent");
  assert.ok(absent.length >= 5);
  assert.ok(absent.every((s) => s.operation === null && s.answer));
  assert.ok(absent.some((s) => /API 키/.test(s.request)), "키 입력은 화면에서 사람이 한다");
});

test("같은 작업은 늘 같은 말끝을 고른다", () => {
  const first = buildSamples(catalog).map((s) => s.request);
  const second = buildSamples(catalog).map((s) => s.request);
  assert.deepEqual(first, second);
});

test("설명이 빈 작업은 호출 표본을 만들지 않는다", () => {
  const samples = buildSamples({ read: [{ operation: "quiet_op", description: "", arguments: {} }], execute: [] });
  assert.equal(samples.filter((s) => s.kind === "call").length, 0);
  assert.equal(samples.filter((s) => s.kind === "name").length, 1);
});
