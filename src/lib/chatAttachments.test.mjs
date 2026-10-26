import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  LoginRequiredError,
  loginRequiredStore,
  loginSessionToken,
  setLoginSessionToken,
} from "./loginSession.ts";

// V4/C20: 실제 첨부 API·오류 처리·로그인 상태를 연결하고 HTTP만 모의한다.
const transportUrl = new URL("./ipcTransport.ts", import.meta.url).href;
const accessUrl = new URL("./chatAccess.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === accessUrl && specifier === "./ipc.ts") {
      return nextResolve(transportUrl, context);
    }
    if (context.parentURL === transportUrl && ["./backendErrors", "./backend"].includes(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});
let attachments;
let transport;
try {
  attachments = await import("./chatAttachments.ts");
  transport = await import(transportUrl);
} finally {
  hooks.deregister();
}

const access = {
  protocolVersion: 14,
  storeId: "00000000-0000-0000-0000-000000000001",
  instanceId: "test-backend",
  backendPort: 54178,
  mode: "tailscale",
  remote: true,
  channel: "remote",
  authenticated: true,
  loginRequired: { password: true, otp: false },
  headless: true,
};
const file = { id: "attachment-1", name: "note.txt", kind: "file", sizeBytes: 4 };
const operations = {
  read: () => attachments.readChatInputFile("chat-1", file),
  remove: () => attachments.removeChatInputFile("chat-1", file.id),
  upload: () => attachments.uploadChatInputFile("chat-1", new File(["note"], "note.txt")),
};

function fixture(t, respond) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const stored = new Map();
  globalThis.window = {
    location: { protocol: "https:", host: "manager.example.test" },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
  };
  transport.resetBackendProtocolHandshake();
  loginRequiredStore.clear();
  setLoginSessionToken("expired-test-session");
  let accessCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname === "/api/access") {
      accessCalls += 1;
      return Response.json(access);
    }
    assert.equal(new Headers(init?.headers).get("X-Agent-Manager-Session"), "expired-test-session");
    return respond(url, init);
  };
  t.after(() => {
    setLoginSessionToken(null);
    loginRequiredStore.clear();
    transport.resetBackendProtocolHandshake();
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return { stored, accessCalls: () => accessCalls };
}

for (const [name, run] of Object.entries(operations)) {
  test(`C20-9/V4: attachment ${name} reopens sign-in after a LOGIN_REQUIRED response`, async (t) => {
    const requirement = { password: name !== "read", otp: name !== "remove" };
    const response = Response.json({
      code: "LOGIN_REQUIRED",
      error: "다시 로그인하세요.",
      params: { password: String(requirement.password), otp: String(requirement.otp) },
    }, { status: 401 });
    const state = fixture(t, () => response);
    await transport.ensureBackendProtocol();
    await assert.rejects(run(), (error) => {
      assert.ok(error instanceof LoginRequiredError);
      assert.deepEqual(error.requirement, requirement);
      return true;
    });
    assert.equal(loginSessionToken(), null);
    assert.equal(state.stored.size, 0, "the expired token must leave persistent UI storage too");
    assert.deepEqual(loginRequiredStore.get(), requirement);
    const before = state.accessCalls();
    await transport.ensureBackendProtocol();
    assert.equal(state.accessCalls(), before + 1, "the authenticated handshake must be invalidated");
  });
}

for (const [status, body, expected] of [
  [401, { error: "첨부 접근 거절" }, "첨부 접근 거절"],
  [404, { error: "첨부 없음" }, "첨부 없음"],
  [403, { code: "LOGIN_REQUIRED", error: "접근 거절" }, "접근 거절"],
  [502, null, "첨부 파일을 읽지 못했습니다 (502)"],
]) {
  test(`C20-9/V4: attachment error ${status} without a 401 LOGIN_REQUIRED pair preserves sign-in`, async (t) => {
    fixture(t, () => body ? Response.json(body, { status }) : new Response("bad gateway", { status }));
    await assert.rejects(operations.read(), { message: expected });
    assert.equal(loginSessionToken(), "expired-test-session");
    assert.equal(loginRequiredStore.get(), null);
  });
}

test("V4: successful attachment responses keep their upload JSON and file bytes", async (t) => {
  fixture(t, (url) => new URL(url).pathname === "/api/chat-attachment"
    ? Response.json(file)
    : new Response("note"));
  assert.deepEqual(await operations.upload(), file);
  assert.equal(await (await operations.read()).text(), "note");
  assert.equal(await operations.remove(), undefined);
  assert.equal(loginRequiredStore.get(), null);
});
