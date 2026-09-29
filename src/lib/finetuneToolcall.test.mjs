import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { extract, indexCatalog, isFailure, isSelfContained, shapeOf } from "../../local-llm-dev/finetune/export-aia-toolcall.mjs";

const catalog = {
  read: [{ operation: "list_sessions", description: "세션 목록", arguments: { limit: 20 } }],
  execute: [{ operation: "patch_session_meta", description: "세션 메타 수정", arguments: { sessionId: "ses_x", patch: {} } }],
};
const index = indexCatalog(catalog);

test("카탈로그를 작업 이름으로 편다", () => {
  assert.equal(index.size, 2);
  assert.equal(index.get("list_sessions").tool, "system_read");
  assert.equal(index.get("patch_session_meta").tool, "system_execute");
});

test("오류 결과를 가려낸다", () => {
  assert.equal(isFailure("Error: get_scheduled_run_detail 실패: missing field `id`"), true);
  assert.equal(isFailure([{ text: "오류: 없는 작업" }]), true);
  assert.equal(isFailure('{"result": {"items": []}}'), false);
});

test("인자는 키와 자료형 모양만 남긴다", () => {
  assert.deepEqual(shapeOf({ id: "ses_x", limit: 20, patch: { title: "가" }, tags: ["a"] }), {
    id: "string", limit: "number", patch: { title: "string" }, tags: ["string"],
  });
  assert.deepEqual(shapeOf({}), {});
});

const user = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const result = (id, text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
const assistant = (blocks) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
const call = (id, name, input) => ({ type: "tool_use", id, name, input });

function write(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toolcall-")), "t.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

test("성공한 호출만 요청과 짝지어 뽑는다", () => {
  const file = write([
    user("세션 목록을 스무 건만 보여줘 정리하려고 해"),
    assistant([call("c1", "mcp__aia_system__system_read", { operation: "list_sessions", arguments: { limit: 20 } })]),
    result("c1", '{"result":{"items":[]}}'),
    user("이 세션 제목을 알아볼 수 있게 고쳐줘"),
    assistant([call("c2", "mcp__aia_system__system_execute", { operation: "patch_session_meta", arguments: { id: "ses_x" } })]),
    result("c2", "Error: 요청 인자가 올바르지 않습니다: missing field `sessionId`"),
  ]);
  const items = extract(file, index);
  assert.equal(items.length, 1, "오류로 끝난 호출은 정답이 아니다");
  assert.equal(items[0].operation, "list_sessions");
  assert.equal(items[0].tool, "system_read");
  assert.deepEqual(items[0].argumentShape, { limit: "number" });
  assert.deepEqual(items[0].catalogArguments, { limit: 20 });
});

test("카탈로그에 없는 작업과 자동 글은 뺀다", () => {
  const file = write([
    user("예전에 쓰던 그 작업을 다시 한 번 불러줘"),
    assistant([call("c1", "mcp__aia_system__system_read", { operation: "get_removed_thing", arguments: {} })]),
    result("c1", '{"result":{}}'),
    user("<task-notification><task-id>x</task-id></task-notification>"),
    assistant([call("c2", "mcp__aia_system__system_read", { operation: "list_sessions", arguments: {} })]),
    result("c2", '{"result":{}}'),
  ]);
  assert.deepEqual(extract(file, index), []);
});

test("이어가기 한 마디는 표본이 아니다", () => {
  assert.equal(isSelfContained("계속"), false);
  assert.equal(isSelfContained("진행 "), false);
  assert.equal(isSelfContained("ok"), false);
  assert.equal(isSelfContained("짧다"), false, "스무 자 미만은 무엇을 부를지 못 정한다");
  assert.equal(isSelfContained("미분류 세션 목록을 보여주고 폴더를 정해줘"), true);
});

test("이어가기 요청 뒤의 호출은 뽑지 않는다", () => {
  const file = write([
    user("계속"),
    assistant([call("c1", "mcp__aia_system__system_read", { operation: "list_sessions", arguments: {} })]),
    result("c1", '{"result":{}}'),
    user("세션 목록을 스무 건만 보여줘 정리하게"),
    assistant([call("c2", "mcp__aia_system__system_read", { operation: "list_sessions", arguments: { limit: 20 } })]),
    result("c2", '{"result":{}}'),
  ]);
  const items = extract(file, index);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].arguments, { limit: 20 });
});
