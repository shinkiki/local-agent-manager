import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMMENT_CHARS,
  canCreateSshKey,
  canSaveSshKeyNote,
  isKeyTask,
  isRowBusy,
  keyTask,
  serversUsingKey,
} from "./sshKeyTask.ts";

const fp = "SHA256:abc";
const other = "SHA256:xyz";

test("keyTask는 갈래와 지문을 한 토큰으로 묶고 isKeyTask는 그 갈래만 참이다", () => {
  const busy = keyTask("reveal", fp);
  assert.equal(busy, "reveal:SHA256:abc");
  assert.equal(isKeyTask(busy, "reveal", fp), true);
  assert.equal(isKeyTask(busy, "delete", fp), false);
  assert.equal(isKeyTask(busy, "reveal", other), false);
  assert.equal(isKeyTask(null, "reveal", fp), false);
});

test("isRowBusy는 갈래를 가리지 않고 이 지문을 대상으로 한 동작만 본다", () => {
  assert.equal(isRowBusy(null, fp), false);
  assert.equal(isRowBusy("create", fp), false);
  for (const kind of ["reveal", "note", "passphrase", "delete"]) {
    assert.equal(isRowBusy(keyTask(kind, fp), fp), true, kind);
  }
  assert.equal(isRowBusy(keyTask("note", other), fp), false);
  // `:` 경계 — 앞에 글자가 붙은 다른 지문을 이 지문으로 오인하지 않는다.
  assert.equal(isRowBusy(keyTask("note", `x${fp}`), fp), false);
  assert.equal(isRowBusy(`note:${fp}2`, fp), false);
});

test("serversUsingKey는 지문이 같은 서버만 고르고 목록이 없으면 빈 배열이다", () => {
  const a = { id: "srv-a", fingerprint: fp };
  const b = { id: "srv-b", fingerprint: other };
  const c = { id: "srv-c", fingerprint: fp };
  assert.deepEqual(serversUsingKey([a, b, c], fp), [a, c]);
  assert.deepEqual(serversUsingKey([a, b, c], "SHA256:none"), []);
  assert.deepEqual(serversUsingKey(undefined, fp), []);
  assert.deepEqual(serversUsingKey(null, fp), []);
});

test("canCreateSshKey는 빈 파일 이름·설명 한도 초과·암호 불일치·진행 중이면 끈다", () => {
  const ok = { fileName: "id_test", comment: "me", passphraseMismatch: false, busy: false };
  assert.equal(canCreateSshKey(ok), true);
  assert.equal(canCreateSshKey({ ...ok, fileName: "   " }), false);
  assert.equal(canCreateSshKey({ ...ok, busy: true }), false);
  assert.equal(canCreateSshKey({ ...ok, passphraseMismatch: true }), false);
  assert.equal(canCreateSshKey({ ...ok, comment: "a".repeat(MAX_COMMENT_CHARS) }), true);
  assert.equal(canCreateSshKey({ ...ok, comment: "a".repeat(MAX_COMMENT_CHARS + 1) }), false);
  assert.equal(canCreateSshKey({ ...ok, comment: "" }), true);
});

test("canSaveSshKeyNote는 다듬은 초안이 지금 메모와 다를 때만 켜고 행이 바쁘면 끈다", () => {
  assert.equal(canSaveSshKeyNote("운영 접속용", null, false), true);
  assert.equal(canSaveSshKeyNote("운영 접속용", undefined, false), true);
  assert.equal(canSaveSshKeyNote("   ", null, false), false);
  assert.equal(canSaveSshKeyNote("  운영 접속용  ", "운영 접속용", false), false);
  assert.equal(canSaveSshKeyNote("스테이징", "운영 접속용", false), true);
  // 비우는 것도 변경이다 — 버튼은 "메모 지우기"로 바뀐다.
  assert.equal(canSaveSshKeyNote("", "운영 접속용", false), true);
  assert.equal(canSaveSshKeyNote("스테이징", "운영 접속용", true), false);
});
