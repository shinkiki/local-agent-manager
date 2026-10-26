import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// V4: 실제 세션 API·전송을 연결하고 HTTP와 시간 초과 신호 발생만 제어한다.
const lib = new URL("./", import.meta.url);
const clientUrl = new URL("ipcSessions.ts", lib).href;
const transportUrl = new URL("ipcTransport.ts", lib).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ([clientUrl, transportUrl].includes(context.parentURL)
      && ["./ipcTransport", "./backend", "./backendErrors", "./sessionImage"].includes(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, lib).href, context);
    }
    return nextResolve(specifier, context);
  },
});
let sessions;
let transport;
try {
  sessions = await import(clientUrl);
  transport = await import(transportUrl);
} finally {
  hooks.deregister();
}

const source = "codex";
const id = "session/한글 기록";
const update = { revision: 7, changed: true };
const scenarios = [
  { command: "reconcile_session_catalog", timeoutMs: 60_000, args: {}, run: () => sessions.reconcileSessionCatalog() },
  { command: "refresh_session_catalog", timeoutMs: 15_000, args: { request: { source, id } }, run: () => sessions.refreshSessionCatalog(source, id) },
];

function fixture(t, scenario, phase) {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { protocol: "https:", host: "manager.example.test" } };
  transport.resetBackendProtocolHandshake();
  const deadlines = [];
  const requests = [];
  let bodyRead = false;
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    const controller = new AbortController();
    deadlines.push({ milliseconds, controller });
    return controller.signal;
  });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).origin, "https://manager.example.test");
    const path = new URL(url).pathname;
    if (path === "/api/access") {
      return Response.json({
        protocolVersion: 14,
        storeId: "00000000-0000-0000-0000-000000000001",
        instanceId: "test-backend",
        backendPort: 54178,
        mode: "tailscale",
        remote: true,
        channel: "remote",
        authenticated: false,
        loginRequired: { password: false, otp: false },
        headless: true,
      });
    }
    assert.equal(path, `/api/invoke/${scenario.command}`);
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), scenario.args);
    requests.push(init);
    assert.ok(init.signal instanceof AbortSignal, "갱신 요청에는 중단 신호가 있어야 한다");
    assert.equal(init.signal.aborted, false, "재시도는 이전 중단 신호를 재사용하지 않는다");
    const { controller } = deadlines.at(-1);
    assert.equal(init.signal, controller.signal);
    if (requests.length > 1) return Response.json(update);
    const reason = new DOMException("test deadline elapsed", "TimeoutError");
    if (phase === "headers") {
      controller.abort(reason);
      throw reason;
    }
    // 헤더는 성공했지만 JSON 일부만 받은 상태에서 fetch 본문이 중단되는 상황이다.
    return new Response(new ReadableStream({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"revision":'));
      },
      pull(stream) {
        bodyRead = true;
        controller.abort(reason);
        stream.error(reason);
      },
    }));
  });
  t.after(() => {
    transport.resetBackendProtocolHandshake();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { deadlines, requests, bodyWasRead: () => bodyRead };
}

for (const scenario of scenarios) {
  for (const phase of ["headers", "body"]) {
    test(`V4: ${scenario.command}의 ${phase} 시간 초과를 알리고 새 요청으로 재시도한다`, async (t) => {
      const backend = fixture(t, scenario, phase);
      await assert.rejects(scenario.run(), (error) => {
        assert.ok(error instanceof transport.BackendTimeoutError);
        assert.equal(error.command, scenario.command);
        return true;
      });
      assert.equal(backend.requests.length, 1, "호출자의 재시도 전에는 자동 재요청하지 않는다");
      assert.deepEqual(backend.deadlines.map(({ milliseconds }) => milliseconds), [scenario.timeoutMs]);
      assert.equal(backend.requests[0].signal.aborted, true);
      assert.equal(backend.bodyWasRead(), phase === "body");

      assert.deepEqual(await scenario.run(), update);
      assert.equal(backend.requests.length, 2);
      assert.deepEqual(backend.deadlines.map(({ milliseconds }) => milliseconds), [scenario.timeoutMs, scenario.timeoutMs]);
      assert.notEqual(backend.requests[0].signal, backend.requests[1].signal);
      assert.equal(backend.requests[1].signal.aborted, false);
    });
  }
}
