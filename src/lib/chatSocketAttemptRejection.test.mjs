import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { ChatRejectedError } from "./chatReconnect.ts";

// V4: 재연결 거절은 바깥 수명주기가 분류한다. 시도 자체가 기존 스트림을 비우거나
// 오류를 먼저 표시하면, 일시 거절 때 대화가 사라지거나 종료 안내가 중복된다.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./chatAccess.ts") {
      return {
        url: "data:text/javascript,export async function assertRemoteChatAccess() {}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { openChatSocket } = await import("./chatSocketAttempt.ts");

for (const code of ["unavailable", "chatMissing", "sessionBusy"]) {
  test(`V4: ${code} 재연결 거절은 대화를 보존하고 분류용 오류만 돌려준다`, async (t) => {
    const timers = new Map();
    const previousWindow = globalThis.window;
    const previousSocket = globalThis.WebSocket;
    let socket;
    globalThis.window = {
      setTimeout(callback) { timers.set(1, callback); return 1; },
      clearTimeout(id) { timers.delete(id); },
    };
    globalThis.WebSocket = class {
      listeners = {};
      constructor() { socket = this; }
      addEventListener(type, listener) { this.listeners[type] = listener; }
    };
    t.after(() => {
      globalThis.window = previousWindow;
      globalThis.WebSocket = previousSocket;
    });

    const previousSession = { chatId: "chat-existing", state: "running" };
    const events = [{ type: "message", message: "이미 받은 대화" }];
    let scheduled = 0;
    let stopped = 0;
    const target = {
      url: "ws://127.0.0.1/chat",
      socket: null,
      detached: false,
      takenOver: false,
      activeChatId: previousSession.chatId,
      lastSession: previousSession,
      eventBatch: { push: (event) => events.push(event), flush() {} },
      reconnectWatch: {
        schedule() { scheduled += 1; },
        stop() { stopped += 1; },
      },
    };
    const opened = openChatSocket(target, { type: "attach", chatId: previousSession.chatId }, true);
    socket.listeners.message({ data: JSON.stringify({
      type: "rejected", code, message: "연결 거절", existingChatId: "chat-other",
    }) });
    socket.listeners.close();

    await assert.rejects(opened, (cause) => {
      assert.ok(cause instanceof ChatRejectedError);
      assert.equal(cause.code, code);
      assert.equal(cause.message, "연결 거절");
      assert.equal(cause.existingChatId, "chat-other");
      return true;
    });
    assert.deepEqual(events, [{ type: "message", message: "이미 받은 대화" }]);
    assert.equal(target.lastSession, previousSession);
    assert.equal(target.activeChatId, previousSession.chatId);
    assert.equal(target.detached, false);
    assert.equal(target.takenOver, false);
    assert.equal(target.socket, null);
    assert.equal(timers.size, 0, "거절된 시도의 연결 타이머를 걷는다");
    assert.equal(scheduled, 0, "재시도 여부는 바깥 수명주기가 정한다");
    assert.equal(stopped, 0);
  });
}
