import assert from "node:assert/strict";
import test from "node:test";

let instance = 0;
async function freshSession(t, windowValue) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (windowValue === undefined) delete globalThis.window;
  else Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  });
  // 모듈의 메모리 토큰도 새 탭처럼 비워 각 저장소 조건을 독립적으로 검사한다.
  return import(`./loginSession.ts?storage-case=${++instance}`);
}

test("C20-3 저장된 세션은 한 번 읽고 이후 요청 헤더에 유지한다", async (t) => {
  let reads = 0;
  const session = await freshSession(t, { localStorage: {
    getItem(key) {
      assert.equal(key, "agentManager.loginSession");
      reads += 1;
      return "stored-test-session";
    },
  } });
  assert.equal(session.loginSessionToken(), "stored-test-session");
  assert.deepEqual(session.loginSessionHeaders(), { "X-Agent-Manager-Session": "stored-test-session" });
  assert.equal(reads, 1);
});

test("C20-3 저장소 읽기가 거절돼도 요청을 계속하고 메모리 로그인과 로그아웃을 유지한다", async (t) => {
  let reads = 0;
  const session = await freshSession(t, { localStorage: {
    getItem() { reads += 1; throw new Error("storage read denied"); },
    setItem() { throw new Error("storage write denied"); },
    removeItem() { throw new Error("storage removal denied"); },
  } });
  assert.equal(session.loginSessionToken(), null);
  assert.deepEqual(session.loginSessionHeaders(), {});
  assert.equal(reads, 1, "읽기 실패도 기억해 요청마다 다시 읽지 않는다");
  session.setLoginSessionToken("memory-test-session");
  assert.deepEqual(session.loginSessionHeaders(), { "X-Agent-Manager-Session": "memory-test-session" });
  session.setLoginSessionToken(null);
  assert.equal(session.loginSessionToken(), null);
  assert.deepEqual(session.loginSessionHeaders(), {});
  assert.equal(reads, 1);
});

test("C20-3 저장소 객체 접근이 거절돼도 메모리 세션을 쓸 수 있다", async (t) => {
  const session = await freshSession(t, {
    get localStorage() { throw new Error("storage access denied"); },
  });
  assert.deepEqual(session.loginSessionHeaders(), {});
  session.setLoginSessionToken("memory-test-session");
  assert.equal(session.loginSessionToken(), "memory-test-session");
  session.setLoginSessionToken(null);
  assert.deepEqual(session.loginSessionHeaders(), {});
});

test("C20-3 브라우저 저장소가 없으면 메모리 세션만 쓴다", async (t) => {
  const session = await freshSession(t, undefined);
  assert.equal(session.loginSessionToken(), null);
  session.setLoginSessionToken("memory-test-session");
  assert.equal(session.loginSessionToken(), "memory-test-session");
  session.setLoginSessionToken("");
  assert.deepEqual(session.loginSessionHeaders(), {});
});
