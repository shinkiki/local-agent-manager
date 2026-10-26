import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  loginRequiredStore,
  loginSessionToken,
  setLoginSessionToken,
} from "./loginSession.ts";

// C20-3/C20-9/V4: 실제 로그인 API·토큰 저장·전송·악수 캐시를 연결하고 HTTP만 대역으로 둔다.
const lib = new URL("./", import.meta.url);
const loginUrl = new URL("ipcLogin.ts", lib).href;
const transportUrl = new URL("ipcTransport.ts", lib).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ([loginUrl, transportUrl].includes(context.parentURL)
      && ["./backend", "./backendErrors", "./ipcTransport", "./i18nRuntime", "./loginSession"].includes(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, lib).href, context);
    }
    return nextResolve(specifier, context);
  },
});
let client;
let transport;
try {
  client = await import(loginUrl);
  transport = await import(transportUrl);
} finally {
  hooks.deregister();
}

const TOKEN_KEY = "agentManager.loginSession";
const requirement = { password: true, otp: true };
const form = { userId: "test-user", password: "test-password", otp: "123456" };

function fixture(t, respond) {
  const originalWindow = globalThis.window;
  const stored = new Map();
  const requests = [];
  globalThis.window = {
    location: { protocol: "https:", host: "manager.example.test" },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
  };
  setLoginSessionToken("test-old-session");
  loginRequiredStore.raise(requirement);
  transport.resetBackendProtocolHandshake();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(url).pathname;
    const token = new Headers(init?.headers).get("X-Agent-Manager-Session");
    requests.push({ path, token, method: init?.method, body: init?.body });
    if (path === "/api/access") {
      return Response.json({
        protocolVersion: 14,
        storeId: "00000000-0000-0000-0000-000000000001",
        instanceId: "test-backend",
        backendPort: 54178,
        mode: "tailscale",
        remote: true,
        channel: "remote",
        authenticated: token !== null,
        loginRequired: requirement,
        headless: true,
      });
    }
    return respond(path, init);
  });
  t.after(() => {
    setLoginSessionToken(null);
    loginRequiredStore.clear();
    transport.resetBackendProtocolHandshake();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { stored, requests };
}

test("C20-3/C20-9 V4: 정상 로그인은 저장한 새 토큰으로 악수와 후속 요청을 다시 보낸다", async (t) => {
  const settings = { userId: "test-user" };
  const { stored, requests } = fixture(t, (path, init) => {
    assert.equal(init.method, "POST");
    if (path === "/api/login") {
      assert.deepEqual(JSON.parse(init.body), form);
      return Response.json({ token: "test-new-session" });
    }
    assert.equal(path, "/api/invoke/get_login_settings");
    assert.deepEqual(JSON.parse(init.body), {});
    return Response.json(settings);
  });
  await transport.ensureBackendProtocol();
  await client.login(form);
  assert.equal(loginSessionToken(), "test-new-session");
  assert.equal(stored.get(TOKEN_KEY), "test-new-session");
  assert.equal(loginRequiredStore.get(), null);
  assert.deepEqual(await client.getLoginSettings(), settings);
  assert.deepEqual(requests.map(({ path, token }) => ({ path, token })), [
    { path: "/api/access", token: "test-old-session" },
    { path: "/api/login", token: "test-old-session" },
    { path: "/api/access", token: "test-new-session" },
    { path: "/api/invoke/get_login_settings", token: "test-new-session" },
  ]);
});

test("C20-3/C20-9 V4: 토큰 없는 성공 응답은 기존 세션과 로그인 요구를 바꾸지 않는다", async (t) => {
  let response;
  const { stored, requests } = fixture(t, (path) => {
    assert.equal(path, "/api/login");
    return response;
  });
  await transport.ensureBackendProtocol();
  for (const body of ["invalid-json", "null", "{}", '{"token":""}', '{"token":123}']) {
    response = new Response(body, { status: 200 });
    await assert.rejects(client.login(form), { message: "로그인 응답이 올바르지 않습니다." });
    assert.equal(loginSessionToken(), "test-old-session");
    assert.equal(stored.get(TOKEN_KEY), "test-old-session");
    assert.deepEqual(loginRequiredStore.get(), requirement);
    await transport.ensureBackendProtocol();
  }
  assert.equal(requests.filter(({ path }) => path === "/api/access").length, 1);
});

for (const mode of ["denied", "network"]) {
  test(`C20-9 V4: 로그인 ${mode} 실패는 기존 세션을 보존하고 호출자에게 전달된다`, async (t) => {
    const unavailable = new Error("test network failure");
    const { stored } = fixture(t, (path) => {
      assert.equal(path, "/api/login");
      if (mode === "network") throw unavailable;
      return Response.json({ error: "test sign-in denied", code: "LOGIN_INVALID" }, { status: 401 });
    });
    await assert.rejects(client.login(form), (error) => mode === "network"
      ? error instanceof transport.RemoteConnectionError && error.cause === unavailable
      : error.code === "LOGIN_INVALID");
    assert.equal(loginSessionToken(), "test-old-session");
    assert.equal(stored.get(TOKEN_KEY), "test-old-session");
    assert.deepEqual(loginRequiredStore.get(), requirement);
  });
}

for (const mode of ["ok", "denied", "network"]) {
  test(`C20-3/C20-9 V4: 로그아웃 ${mode} 뒤 토큰과 이전 악수를 버린다`, async (t) => {
    const unavailable = new Error("test network failure");
    const { stored, requests } = fixture(t, (path, init) => {
      assert.equal(path, "/api/logout");
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), {});
      if (mode === "network") throw unavailable;
      return new Response(null, { status: mode === "ok" ? 200 : 503 });
    });
    assert.equal((await transport.ensureBackendProtocol()).authenticated, true);
    if (mode === "network") {
      await assert.rejects(client.logout(), (error) =>
        error instanceof transport.RemoteConnectionError && error.cause === unavailable);
    } else {
      await client.logout();
    }
    assert.equal(loginSessionToken(), null);
    assert.equal(stored.has(TOKEN_KEY), false);
    assert.equal((await transport.ensureBackendProtocol()).authenticated, false);
    assert.deepEqual(requests.map(({ path, token }) => ({ path, token })), [
      { path: "/api/access", token: "test-old-session" },
      { path: "/api/logout", token: "test-old-session" },
      { path: "/api/access", token: null },
    ]);
  });
}
