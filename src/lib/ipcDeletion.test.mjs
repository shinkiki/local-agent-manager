import assert from "node:assert/strict";
import test from "node:test";
import { userActorRequest, userConfirmedDeleteRequest } from "./ipcDeletion.ts";

test("삭제 요청은 봉투 안에 행위자와 확인 표시를 함께 싣는다", () => {
  assert.deepEqual(
    userConfirmedDeleteRequest({ scope: "personal", provider: "claude" }),
    { request: { scope: "personal", provider: "claude", deletedBy: "user", confirm: true } },
  );
});

test("행위자만 싣는 요청에는 확인 표시가 없다", () => {
  const { request } = userActorRequest({ skillId: "abc" });
  assert.deepEqual(request, { skillId: "abc", deletedBy: "user" });
  assert.ok(!("confirm" in request));
});

test("두 봉투는 같은 행위자 이름을 쓴다", () => {
  assert.equal(
    userConfirmedDeleteRequest({ key: "k" }).request.deletedBy,
    userActorRequest({ key: "k" }).request.deletedBy,
  );
});

test("행위자 이름은 ref가 같은 칸을 들고 와도 봉투가 정한 값으로 남는다", () => {
  assert.equal(userActorRequest({ deletedBy: "agent" }).request.deletedBy, "user");
});
