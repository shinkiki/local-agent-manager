import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// V4: 부모 생략은 위치 유지, null은 최상위 이동이다. 실제 HTTP 본문까지 확인한다.
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

const id = "folder/한글 기록";
const folder = {
  id, name: "업무", color: "#336699", parentId: "parent-before", hidden: false,
  sortOrder: 2, depth: 1, sessionCount: 3, totalSessionCount: 5,
};

function fixture(t, payload = folder, status = 200) {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { protocol: "https:", host: "manager.example.test" } };
  transport.resetBackendProtocolHandshake();
  t.after(() => {
    transport.resetBackendProtocolHandshake();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://manager.example.test");
    if (target.pathname === "/api/access") {
      return Response.json({
        protocolVersion: 14, storeId: "00000000-0000-0000-0000-000000000001",
        instanceId: "test-backend", backendPort: 54178, mode: "tailscale", remote: true,
        channel: "remote", authenticated: false,
        loginRequired: { password: false, otp: false }, headless: true,
      });
    }
    assert.equal(target.pathname, "/api/invoke/update_session_folder");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("content-type"), "application/json");
    requests.push(JSON.parse(init.body));
    return Response.json(payload, { status });
  });
  return requests;
}

test("V4: 이름·숨김 변경은 부모를 생략해 기존 폴더 위치를 유지한다", async (t) => {
  const requests = fixture(t);
  for (const patch of [
    { name: "새 이름", color: "#abcdef" },
    { hidden: true },
    { hidden: false },
    { hidden: false, parentId: undefined },
  ]) {
    const before = structuredClone(patch);
    assert.deepEqual(await sessions.updateSessionFolder(id, Object.freeze(patch)), folder);
    const sent = requests.at(-1);
    assert.equal(Object.hasOwn(sent.request, "parentId"), false,
      "부모 생략을 null로 바꾸면 숨김·이름 변경이 최상위 이동으로 바뀐다");
    assert.deepEqual(sent, { request: { id, ...JSON.parse(JSON.stringify(before)) } });
    assert.deepEqual(patch, before);
  }
  assert.equal(requests.length, 4, "사용자 변경 한 번에 요청 한 번만 보낸다");
});

test("V4: 명시적 최상위·다른 부모 이동과 숨김 해제를 함께 보존한다", async (t) => {
  const requests = fixture(t);
  for (const parentId of [null, "parent/다른 폴더"]) {
    const patch = Object.freeze({ parentId, hidden: false });
    assert.deepEqual(await sessions.updateSessionFolder(id, patch), folder);
    assert.deepEqual(requests.at(-1), { request: { id, parentId, hidden: false } });
    assert.deepEqual(patch, { parentId, hidden: false });
  }
  assert.equal(requests.length, 2);
});

test("V4: 잘못된 부모 이동의 거절을 성공으로 바꾸거나 자동 재요청하지 않는다", async (t) => {
  const rejected = {
    error: "폴더를 자기 자신의 하위로 옮길 수 없습니다",
    code: "SESSION_FOLDER_PARENT_IS_SELF", params: {},
  };
  const requests = fixture(t, rejected, 400);
  const patch = Object.freeze({ parentId: id });
  await assert.rejects(sessions.updateSessionFolder(id, patch), (error) => {
    assert.equal(error.name, "BackendCodedError");
    assert.equal(error.code, rejected.code);
    assert.deepEqual(error.params, rejected.params);
    return true;
  });
  assert.deepEqual(requests, [{ request: { id, parentId: id } }]);
  assert.deepEqual(patch, { parentId: id });
});
