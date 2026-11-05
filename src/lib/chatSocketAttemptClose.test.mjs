import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createChatEventBatch } from "./chatEventBatch.ts";
import { createHandleRegistry } from "./cancelableHandleFixtures.mjs";

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

// V2/V4: 소켓 종료 시험의 빈 flush 대역으로는 마지막 스트림 조각의 전달 순서를
// 확인할 수 없다. 실제 배치를 연결하고 다음 프레임 전에 소켓을 닫는다.
for (const reconnecting of [false, true]) {
  test(`V4: ${reconnecting ? "재연결" : "첫 연결"} 종료는 마지막 조각을 재연결 예약 전에 전달한다`, async (t) => {
    const previousWindow = globalThis.window;
    const previousSocket = globalThis.WebSocket;
    const timers = createHandleRegistry();
    const frames = createHandleRegistry();
    const delivered = [];
    const order = [];
    let socket;
    const batch = createChatEventBatch((event) => {
      delivered.push(event);
      order.push("event");
    }, { request: frames.start, cancel: frames.stop });
    t.after(() => {
      batch.dispose();
      globalThis.window = previousWindow;
      globalThis.WebSocket = previousSocket;
    });
    globalThis.window = { setTimeout: timers.start, clearTimeout: timers.stop };
    globalThis.WebSocket = class {
      listeners = {};
      constructor() { socket = this; }
      addEventListener(type, listener) { this.listeners[type] = listener; }
      emit(type, payload) { this.listeners[type](payload); }
    };
    const target = {
      url: "ws://127.0.0.1/chat",
      socket: null,
      detached: false,
      takenOver: false,
      activeChatId: null,
      lastSession: null,
      eventBatch: batch,
      reconnectWatch: { schedule() { order.push("reconnect"); }, stop() {} },
    };
    const opened = openChatSocket(target, { type: "attach", chatId: "chat-1" }, reconnecting);
    const session = { chatId: "chat-1", state: "running" };
    socket.emit("message", { data: JSON.stringify({ type: "state", session }) });
    await opened;
    delivered.length = 0;
    order.length = 0;

    const tail = [
      { type: "messageDelta", id: "answer", role: "assistant", kind: "text", delta: "마지막 답변" },
      { type: "tool", id: "tool-1", name: "명령 실행", status: "running", detail: null, output: "마지막 출력", append: true },
    ];
    for (const event of tail) socket.emit("message", { data: JSON.stringify(event) });
    assert.deepEqual(delivered, [], "프레임 전에는 마지막 조각들이 배치에 남아 있다");
    assert.equal(frames.pending, 1);
    const lateFrame = [...frames.handles.values()][0];

    socket.emit("close");

    assert.deepEqual(delivered, tail, "닫힘이 대기 중인 답변과 도구 출력을 보존한다");
    assert.deepEqual(order, ["event", "event", "reconnect"], "출력 전달 뒤에 재연결을 예약한다");
    assert.equal(target.socket, null);
    assert.equal(frames.pending, 0, "닫힘이 프레임 예약을 걷는다");
    assert.equal(timers.pending, 0, "연결 성립이 대기 타이머를 걷는다");
    lateFrame();
    assert.deepEqual(delivered, tail, "늦은 프레임도 마지막 조각을 중복 전달하지 않는다");
    assert.deepEqual(order, ["event", "event", "reconnect"]);
  });
}
