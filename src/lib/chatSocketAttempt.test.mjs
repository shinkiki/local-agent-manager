import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// 한 번의 열기 시도가 어떤 결론을 내는지는 이 모듈만 판단한다(chatSocketAttempt.ts 머리말).
// 브라우저 소켓·타이머를 가짜로 바꿔 세 갈래(첫 state·거절·시작 전 끊김)와
// 결론 뒤 끊김의 재연결 예약을 고정한다.

const sockets = [];
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.sent = [];
    this.closed = false;
    sockets.push(this);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type, payload = {}) {
    for (const listener of this.listeners[type] ?? []) listener(payload);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

const timers = new Map();
let nextTimer = 1;
globalThis.WebSocket = FakeSocket;
globalThis.window = {
  setTimeout(callback) {
    const id = nextTimer++;
    timers.set(id, callback);
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
};

// chatAccess.ts는 ipc.ts 전체를 끌어와 node에서 읽히지 않는다. 소켓 오류 갈래만 쓰는
// 함수라 이 시험에서는 통과하는 대역으로 바꾼다.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./chatAccess.ts") {
      return {
        url: "data:text/javascript,export async function assertRemoteChatAccess() { if (globalThis.chatAccessError) throw globalThis.chatAccessError; }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { openChatSocket } = await import("./chatSocketAttempt.ts");

function target() {
  const pushed = [];
  let scheduled = 0;
  let stopped = 0;
  return {
    pushed,
    scheduledCount: () => scheduled,
    stoppedCount: () => stopped,
    url: "ws://127.0.0.1/chat",
    socket: null,
    detached: false,
    takenOver: false,
    activeChatId: null,
    lastSession: null,
    eventBatch: { push: (event) => pushed.push(event), flush() {}, dispose() {} },
    reconnectWatch: {
      schedule: () => {
        scheduled += 1;
      },
      stop: () => {
        stopped += 1;
      },
    },
  };
}

const session = { chatId: "chat-1" };
const message = (event) => ({ data: JSON.stringify(event) });

test("첫 state가 연결 성립이고, 그 뒤 끊기면 재연결을 예약한다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
  const socket = sockets.at(-1);
  assert.equal(t.socket, socket);
  socket.emit("message", message({ type: "state", session }));
  assert.deepEqual(await opened, session);
  assert.equal(t.activeChatId, "chat-1");
  assert.equal(timers.size, 0, "결론이 나면 대기 타이머를 걷는다");
  socket.emit("close");
  assert.equal(t.socket, null);
  assert.equal(t.scheduledCount(), 1);
});

test("스스로 끊은 연결은 닫혀도 재연결을 예약하지 않는다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
  const socket = sockets.at(-1);
  socket.emit("message", message({ type: "state", session }));
  await opened;
  t.detached = true;
  socket.emit("close");
  assert.equal(t.scheduledCount(), 0);
});

test("시작 전 닫힘은 백엔드가 먼저 보낸 오류 문구로 실패한다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
  const socket = sockets.at(-1);
  socket.emit("message", message({ type: "error", message: "ACP 기동 실패" }));
  socket.emit("close");
  await assert.rejects(opened, /ACP 기동 실패/);
  assert.equal(t.scheduledCount(), 0);
});

test("거절은 실패로 끝나고 최초 연결이면 오류를 화면에 알린다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
  const socket = sockets.at(-1);
  socket.emit("message", message({ type: "rejected", code: "busy", message: "이미 열림" }));
  await assert.rejects(opened, /이미 열림/);
  assert.deepEqual(t.pushed[0], { type: "error", message: "이미 열림" });
  socket.emit("close");
  assert.equal(t.scheduledCount(), 0, "연결된 적 없는 소켓은 재연결하지 않는다");
});

test("재연결 리플레이는 첫 이벤트 앞에서 한 번만 스트림을 비운다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, true);
  const socket = sockets.at(-1);
  socket.emit("message", message({ type: "state", session }));
  socket.emit("message", message({ type: "state", session }));
  await opened;
  assert.equal(t.pushed.filter((event) => event.type === "replayReset").length, 1);
  assert.equal(t.pushed[0].type, "replayReset");
});

test("시간 초과는 소켓을 닫고 실패로 끝내며, 뒤따르는 닫힘이 결론을 덮지 않는다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
  const socket = sockets.at(-1);
  const [id, fire] = [...timers.entries()].at(-1);
  timers.delete(id);
  fire();
  assert.equal(socket.closed, true);
  socket.emit("close");
  await assert.rejects(opened, /시간이 초과/);
  assert.deepEqual(t.pushed, [], "뒤따른 닫힘은 아무것도 알리지 않는다");
  assert.equal(t.scheduledCount(), 0);
});

test("takenOver는 재연결을 멈춘다", async () => {
  const t = target();
  const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
  const socket = sockets.at(-1);
  socket.emit("message", message({ type: "state", session }));
  await opened;
  socket.emit("message", message({ type: "takenOver" }));
  assert.equal(t.takenOver, true);
  assert.equal(t.detached, true);
  assert.equal(t.stoppedCount(), 1);
  socket.emit("close");
  assert.equal(t.scheduledCount(), 0);
});

test("소켓 오류는 접근 확인이 알려 준 이유로 실패하고, 그 사이 닫힘이 결론을 가로채지 않는다", async () => {
  const t = target();
  globalThis.chatAccessError = new Error("로그인이 필요합니다");
  try {
    const opened = openChatSocket(t, { type: "attach", chatId: "chat-1" }, false);
    const socket = sockets.at(-1);
    socket.emit("message", message({ type: "error", message: "먼저 온 오류" }));
    socket.emit("error");
    socket.emit("close");
    await assert.rejects(opened, /로그인이 필요합니다/);
    assert.equal(timers.size, 0);
  } finally {
    delete globalThis.chatAccessError;
  }
});

test("열리면 첫 메시지를 보낸다", () => {
  const t = target();
  void openChatSocket(t, { type: "attach", chatId: "chat-1" }, false).catch(() => {});
  const socket = sockets.at(-1);
  socket.readyState = 1;
  socket.emit("open");
  assert.equal(socket.sent.length, 1);
  socket.emit("close");
});
