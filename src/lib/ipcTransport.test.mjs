import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const lib = new URL("./", import.meta.url);
const transportUrl = new URL("ipcTransport.ts", lib).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === transportUrl && ["./backend", "./backendErrors"].includes(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, lib).href, context);
    }
    return nextResolve(specifier, context);
  },
});
let transport;
try {
  transport = await import(transportUrl);
} finally {
  hooks.deregister();
}

function fixture(t) {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { protocol: "https:", host: "manager.example.test" } };
  transport.resetBackendProtocolHandshake();
  t.after(() => {
    transport.resetBackendProtocolHandshake();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", (url) => {
    assert.equal(new URL(url).pathname, "/api/access");
    return new Promise((resolve, reject) => requests.push({ resolve, reject }));
  });
  return requests;
}

function accessResponse() {
  return Response.json({
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
  });
}

for (const completed of [false, true]) {
  test(`V4: an obsolete handshake failure preserves the ${completed ? "completed" : "pending"} replacement`, async (t) => {
    const requests = fixture(t);
    const obsolete = transport.ensureBackendProtocol();
    const unavailable = new Error("obsolete endpoint unavailable");
    const rejected = assert.rejects(obsolete, (error) =>
      error instanceof transport.RemoteConnectionError && error.cause === unavailable);
    transport.resetBackendProtocolHandshake();
    const replacement = transport.ensureBackendProtocol();
    if (completed) {
      requests[1].resolve(accessResponse());
      await replacement;
    }

    requests[0].reject(unavailable);
    await rejected;
    const reused = transport.ensureBackendProtocol();
    // 잘못된 구현이 추가 요청을 만들어도 모두 끝내고 캐시와 네트워크 횟수를 확인한다.
    for (const request of requests) request.resolve(accessResponse());
    await Promise.all([replacement, reused]);
    assert.equal(reused, replacement);
    assert.equal(requests.length, 2);
  });
}

test("V4: the current handshake failure clears the cache and permits a shared retry", async (t) => {
  const requests = fixture(t);
  const failed = transport.ensureBackendProtocol();
  assert.equal(transport.ensureBackendProtocol(), failed);
  const unavailable = new Error("current endpoint unavailable");
  const rejected = assert.rejects(failed, (error) =>
    error instanceof transport.RemoteConnectionError && error.cause === unavailable);
  requests[0].reject(unavailable);
  await rejected;

  const retry = transport.ensureBackendProtocol();
  assert.notEqual(retry, failed);
  assert.equal(transport.ensureBackendProtocol(), retry);
  requests[1].resolve(accessResponse());
  assert.equal((await retry).instanceId, "test-backend");
  assert.equal(transport.ensureBackendProtocol(), retry);
  assert.equal(requests.length, 2);
});
