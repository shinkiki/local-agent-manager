import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { createHandleRegistry } from "./cancelableHandleFixtures.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const modules = {
      "./backend.ts": 'export function backendWebSocketUrl() { return "ws://127.0.0.1/api/chat"; }',
      "./chatAccess.ts": 'export async function assertRemoteChatAccess() { return { instanceId: "backend-1" }; }',
      "./ipc.ts": 'export function getWebAccessStatus() { return globalThis.chatSocketAccessProbe(); }',
    };
    if (Object.hasOwn(modules, specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { openChatRuntime, sendChatSocketMessage, detachChatSocket } = await import("./chatSocket.ts");
const session = { chatId: "chat-1", state: "running" };

async function fixture(t) {
  const timers = createHandleRegistry();
  const frames = createHandleRegistry();
  const sockets = [];
  const probes = [];
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    WebSocket: globalThis.WebSocket,
    chatSocketAccessProbe: globalThis.chatSocketAccessProbe,
  };
  globalThis.window = Object.assign(new EventTarget(), {
    setTimeout: timers.start,
    clearTimeout: timers.stop,
    requestAnimationFrame: frames.start,
    cancelAnimationFrame: frames.stop,
  });
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  globalThis.chatSocketAccessProbe = () => {
    const probe = Promise.withResolvers();
    probes.push(probe);
    return probe.promise;
  };
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    listeners = {};
    constructor() { sockets.push(this); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    send() {}
    close() {
      this.readyState = 3;
      this.listeners.close();
    }
    connect() {
      this.readyState = 1;
      this.listeners.open();
      this.listeners.message({ data: JSON.stringify({ type: "state", session }) });
    }
  };
  let runtime;
  t.after(() => {
    if (runtime) detachChatSocket(runtime);
    Object.assign(globalThis, previous);
  });
  const opening = openChatRuntime({ type: "attach", chatId: session.chatId }, () => {});
  await tick();
  sockets[0].connect();
  ({ runtime } = await opening);
  return {
    runtime, sockets, probes, timers,
    async sendWhileDisconnected() {
      await assert.rejects(sendChatSocketMessage(runtime, { type: "interrupt" }), /연결을 복구/);
    },
    fireLatestTimer() { timers.fire([...timers.handles.keys()].at(-1)); },
  };
}

test("V4: 전송 중 재예약돼도 접근 확인과 attach는 한 번에 하나만 진행한다", async (t) => {
  const it = await fixture(t);
  it.sockets[0].close();
  it.fireLatestTimer();
  assert.equal(it.probes.length, 1);

  await it.sendWhileDisconnected();
  it.fireLatestTimer();
  assert.equal(it.probes.length, 1, "접근 확인이 끝나기 전에는 다음 요청을 시작하지 않는다");

  it.probes[0].resolve({ instanceId: "backend-1" });
  await tick();
  assert.equal(it.sockets.length, 2);
  await it.sendWhileDisconnected();
  it.fireLatestTimer();
  assert.equal(it.probes.length, 1, "attach의 첫 state를 기다리는 동안도 한 시도만 진행한다");
  assert.equal(it.sockets.length, 2);
  it.sockets[1].connect();
  await tick();
  assert.equal(it.runtime.socket, it.sockets[1]);
});

test("V4: 재연결 성공 전에 예약한 타이머는 정상 소켓을 교체하지 않는다", async (t) => {
  const it = await fixture(t);
  it.sockets[0].close();
  it.fireLatestTimer();
  await it.sendWhileDisconnected();
  const queuedRetry = [...it.timers.handles.keys()].at(-1);
  it.probes[0].resolve({ instanceId: "backend-1" });
  await tick();
  it.sockets[1].connect();
  await tick();

  it.timers.fire(queuedRetry);
  assert.equal(it.probes.length, 1, "이미 연결됐으면 남은 예약은 접근 확인도 하지 않는다");
  assert.equal(it.sockets.length, 2);
  assert.equal(it.runtime.socket, it.sockets[1]);
});

test("V4: 재연결 실패 뒤에는 다음 예약이 다시 시도한다", async (t) => {
  const it = await fixture(t);
  it.sockets[0].close();
  it.fireLatestTimer();
  it.probes[0].reject(new Error("일시적인 연결 실패"));
  await tick();
  it.fireLatestTimer();
  assert.equal(it.probes.length, 2, "실패한 시도가 다음 시도를 막지 않는다");
  it.probes[1].resolve({ instanceId: "backend-1" });
  await tick();
  it.sockets[1].connect();
  await tick();
  assert.equal(it.runtime.socket, it.sockets[1]);
});
