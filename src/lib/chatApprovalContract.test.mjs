import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// C9-19, C17-2a, V4: 조립 함수만 검사하면 연결 API가 secret/saveSecret 인자를
// 빠뜨려도 통과한다. 실제 chat.ts와 메시지 조립·직렬화를 실행하고 런타임만 대체한다.
const messagesUrl = new URL("./chatSocketMessages.ts", import.meta.url).href;
const transportUrl = `data:text/javascript,${encodeURIComponent(`
  import { writeChatSocketMessage } from ${JSON.stringify(messagesUrl)};
  export { chatApproveCommand, chatSendCommand } from ${JSON.stringify(messagesUrl)};
  export const opened = [];
  export async function openChatRuntime(firstMessage, onEvent) {
    const runtime = {
      sent: [],
      response: Promise.resolve(),
      socket: { send(data) { runtime.sent.push(JSON.parse(data)); } },
    };
    const info = { chatId: firstMessage.chatId ?? "new-chat" };
    opened.push({ firstMessage, onEvent, runtime, info });
    return { runtime, info };
  }
  export function sendChatSocketMessage(runtime, message) {
    writeChatSocketMessage(runtime.socket, message);
    return runtime.response;
  }
  export function detachChatSocket() {}
`)}`;
const attachmentsUrl = `data:text/javascript,${encodeURIComponent(`
  export function directChatInputFileUrl() {}
  export function readChatInputFile() {}
  export function removeChatInputFile() {}
  export function uploadChatInputFile() {}
`)}`;
const transport = await import(transportUrl);
const clientUrl = new URL("./chat.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === clientUrl) {
      if (specifier === "./chatSocket.ts") return { url: transportUrl, shortCircuit: true };
      if (specifier === "./chatAttachments.ts") return { url: attachmentsUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let chat;
try {
  chat = await import(clientUrl);
} finally {
  hooks.deregister();
}

test("C9-19 C17-2a V4: 새 연결과 재연결의 승인은 입력값과 명시적 저장 선택을 보존한다", async () => {
  for (const connect of [
    () => chat.connectChat({ source: "codex", cwd: "/projects/example", model: null, mode: "workspace", approvalMode: "manual" }, () => {}),
    () => chat.attachChat("existing-chat", () => {}),
  ]) {
    const connection = await connect();
    const { runtime } = transport.opened.at(-1);
    const answers = { "계속할까요?": "예" };
    const originalAnswers = structuredClone(answers);
    for (const [secret, saveSecret, extra] of [
      [undefined, undefined, {}],
      ["", true, {}],
      ["user-input-fixture", undefined, { secret: "user-input-fixture" }],
      ["user-input-fixture", false, { secret: "user-input-fixture" }],
      ["user-input-fixture", true, { secret: "user-input-fixture", saveSecret: true }],
    ]) {
      runtime.sent.length = 0;
      await connection.approve("approval-1", "accept", answers, secret, saveSecret);
      assert.deepEqual(runtime.sent, [{
        type: "approve", approvalId: "approval-1", decision: "accept", answers: originalAnswers, ...extra,
      }]);
      assert.deepEqual(answers, originalAnswers, "비밀값을 화면에 남는 일반 답에 섞지 않는다");
    }
    runtime.sent.length = 0;
    await connection.approve("approval-2", "decline");
    assert.deepEqual(runtime.sent, [{ type: "approve", approvalId: "approval-2", decision: "decline", answers: {} }]);
  }
});

test("C9-19 V4: 다른 채팅에 붙은 뒤에도 승인은 원래 연결에만 전달된다", async () => {
  const first = await chat.attachChat("chat-a", () => {});
  const firstRuntime = transport.opened.at(-1).runtime;
  const second = await chat.attachChat("chat-b", () => {});
  const secondRuntime = transport.opened.at(-1).runtime;
  await first.approve("approval-a", "accept", {}, "fixture-a", true);
  assert.deepEqual(firstRuntime.sent, [{
    type: "approve", approvalId: "approval-a", decision: "accept", answers: {}, secret: "fixture-a", saveSecret: true,
  }]);
  assert.deepEqual(secondRuntime.sent, []);
  await second.approve("approval-b", "decline");
  assert.deepEqual(secondRuntime.sent, [{ type: "approve", approvalId: "approval-b", decision: "decline", answers: {} }]);
  assert.equal(firstRuntime.sent.length, 1);
});

test("V4: 승인 전송이 끝날 때까지 기다리고 거절 이유를 호출자에게 전달한다", async () => {
  const connection = await chat.attachChat("chat-pending", () => {});
  const pending = Promise.withResolvers();
  transport.opened.at(-1).runtime.response = pending.promise;
  let settled = false;
  const request = connection.approve("approval-pending", "accept");
  void request.then(() => { settled = true; }, () => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "전송 완료 전에 화면이 승인 처리를 끝내면 안 된다");
  const failure = new Error("승인 전송 거절");
  const checked = assert.rejects(request, (error) => error === failure);
  pending.reject(failure);
  await checked;
});
