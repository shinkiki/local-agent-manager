import assert from "node:assert/strict";
import test from "node:test";
import { chatApproveCommand, chatSendCommand } from "./chatSocketMessages.ts";

test("send 명령은 비워 둔 칸을 기본값으로 채운다", () => {
  assert.deepEqual(chatSendCommand("안녕"), {
    type: "send",
    text: "안녕",
    steer: false,
    attachmentIds: [],
  });
});

test("send 명령은 화면이 준 값을 그대로 싣는다", () => {
  assert.deepEqual(chatSendCommand("안녕", { steer: true, attachmentIds: ["a1"] }), {
    type: "send",
    text: "안녕",
    steer: true,
    attachmentIds: ["a1"],
  });
});

test("approve 명령은 답이 없으면 빈 객체를 싣고 비밀값 칸은 만들지 않는다", () => {
  const command = chatApproveCommand("ap-1", "allow");
  assert.deepEqual(command, { type: "approve", approvalId: "ap-1", decision: "allow", answers: {} });
  assert.equal("secret" in command, false);
});

test("approve 명령은 빈 비밀값을 싣지 않는다", () => {
  assert.equal("secret" in chatApproveCommand("ap-1", "allow", {}, ""), false);
});

test("approve 명령은 저장 의사를 값과 함께일 때만 싣는다", () => {
  // C17. 저장은 값이 들어오는 그 순간에만 할 수 있다. 값 없는 명령에 의사만 실어 보내면
  // 백엔드가 저장할 것이 없는 요청을 받는다.
  assert.equal("saveSecret" in chatApproveCommand("ap-1", "allow", {}, "", true), false);
  assert.equal("saveSecret" in chatApproveCommand("ap-1", "allow", {}, "pw", false), false);
  assert.equal(chatApproveCommand("ap-1", "allow", {}, "pw", true).saveSecret, true);
});

test("approve 명령은 입력된 비밀값만 싣는다", () => {
  assert.deepEqual(chatApproveCommand("ap-1", "allow", { "계속할까요?": "예" }, "pw"), {
    type: "approve",
    approvalId: "ap-1",
    decision: "allow",
    answers: { "계속할까요?": "예" },
    secret: "pw",
  });
});
