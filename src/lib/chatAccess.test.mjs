import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// V4: 공통 채팅 접근 확인과 실제 HTTP 전송을 연결하고 네트워크·시계만 제어한다.
const lib = new URL("./", import.meta.url);
const accessUrl = new URL("chatAccess.ts", lib).href;
const transportUrl = new URL("ipcTransport.ts", lib).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === accessUrl && specifier === "./ipc.ts") {
      return nextResolve(transportUrl, context);
    }
    if (context.parentURL === transportUrl && ["./backend", "./backendErrors"].includes(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, lib).href, context);
    }
    return nextResolve(specifier, context);
  },
});
let assertRemoteChatAccess;
let RemoteConnectionError;
try {
  ({ assertRemoteChatAccess } = await import(accessUrl));
  ({ RemoteConnectionError } = await import(transportUrl));
} finally {
  hooks.deregister();
}

const access = {
  protocolVersion: 15,
  storeId: "00000000-0000-0000-0000-000000000001",
  instanceId: "test-backend",
  backendPort: 54178,
  mode: "tailscale",
  remote: true,
  channel: "remote",
  authenticated: false,
  loginRequired: { password: false, otp: false },
  headless: true,
};

function fixture(t, response) {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { protocol: "https:", host: "manager.example.test" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const deadlines = [];
  const requests = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://manager.example.test/api/access");
    requests.push(init);
    return response(init);
  });
  return { deadlines, requests };
}

for (const phase of ["headers", "body"]) {
  test(`V4: 채팅 접근 확인은 ${phase} 대기를 중단하고 새 신호로 다시 시도한다`, async (t) => {
    const reason = new DOMException("test deadline elapsed", "TimeoutError");
    let first = true;
    const backend = fixture(t, ({ signal }) => {
      assert.ok(signal instanceof AbortSignal, "응답이 멎어도 채팅 접근 확인이 끝나야 한다");
      assert.equal(signal.aborted, false);
      if (!first) return Response.json(access);
      first = false;
      if (phase === "headers") {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      return new Response(new ReadableStream({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"protocolVersion":'));
          signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
        },
      }));
    });
    const waiting = assertRemoteChatAccess();
    const result = waiting.then((value) => ({ value }), (error) => ({ error }));
    // JSON 본문 읽기까지 진행시킨 뒤 멎은 네트워크의 제한시간을 발생시킨다.
    await new Promise((resolve) => setImmediate(resolve));
    backend.deadlines[0]?.controller.abort(reason);
    const { error } = await result;
    assert.ok(error instanceof RemoteConnectionError);
    assert.equal(error.cause, reason, "시간 초과를 버전 오류나 빈 응답으로 바꾸지 않는다");
    assert.deepEqual(backend.deadlines.map(({ milliseconds }) => milliseconds), [10_000]);
    assert.equal(backend.requests[0].signal.aborted, true);

    assert.deepEqual(await assertRemoteChatAccess(), access);
    assert.equal(backend.requests.length, 2, "호출자가 다시 시도할 때만 새 요청을 보낸다");
    assert.deepEqual(backend.deadlines.map(({ milliseconds }) => milliseconds), [10_000, 10_000]);
    assert.notEqual(backend.requests[0].signal, backend.requests[1].signal);
    assert.equal(backend.requests[1].signal.aborted, false);
  });
}

test("C20·V4: 채팅 접근 확인은 즉시 받은 서버 오류를 그대로 알린다", async (t) => {
  fixture(t, () => Response.json({ error: "접근 확인 실패" }, { status: 503 }));
  await assert.rejects(assertRemoteChatAccess(), /접근 확인 실패/);
});
