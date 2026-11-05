import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { credentialExpiryNoticeKey } from "./accountCredentialExpiry.ts";

const NOW = 1_800_000_000_000;
const KEY = "agentManager.credentialExpiryNotified";
const account = (id, days = 1) => ({ id, displayName: id, credentialExpiresAt: NOW + days * 86_400_000 });
const record = (accounts) => JSON.stringify(accounts.map(credentialExpiryNoticeKey));
const moduleUrl = new URL("./webNotifications.ts", import.meta.url).href;
const nativeUrl = `data:text/javascript,${encodeURIComponent(`
  export function hasTauriRuntime() { return true; }
  export async function showNativeNotification(title, body) {
    globalThis.expiryNotifications.push({ title, body });
  }
`)}`;
let scenario = 0;

async function fixture(t, initial, { failRead = false, failWrite = false } = {}) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldNotifications = Object.getOwnPropertyDescriptor(globalThis, "expiryNotifications");
  let stored = initial;
  globalThis.expiryNotifications = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem(key) {
        if (failRead) throw new Error("read blocked");
        return key === KEY ? stored : null;
      },
      setItem(key, value) {
        if (failWrite) throw new Error("quota exceeded");
        if (key === KEY) stored = value;
      },
    },
  } });
  t.mock.method(Date, "now", () => NOW);
  t.after(() => {
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else delete globalThis.window;
    if (oldNotifications) Object.defineProperty(globalThis, "expiryNotifications", oldNotifications);
    else delete globalThis.expiryNotifications;
  });
  return { notify: await loadNotifications(), reload: loadNotifications, stored: () => stored, events: globalThis.expiryNotifications };
}

async function loadNotifications() {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.split("?")[0] === moduleUrl) {
        if (specifier === "./ipc") return { url: nativeUrl, shortCircuit: true };
        if (specifier.startsWith("./") && !specifier.endsWith(".ts")) {
          return nextResolve(new URL(`${specifier}.ts`, moduleUrl).href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const { notifyExpiringCredentials } = await import(`${moduleUrl}?scenario=${scenario++}`);
    return notifyExpiringCredentials;
  } finally {
    hooks.deregister();
  }
}

test("V4: readable stale storage never repeats an expiry when writes fail", async (t) => {
  const a = account("already-recorded");
  const b = account("new-chain");
  const c = account("later-chain");
  const f = await fixture(t, record([a]), { failWrite: true });
  await f.notify([a, b]);
  assert.equal(f.events.length, 1);
  assert.match(f.events[0].body, /new-chain/);
  await f.notify([a, b]);
  assert.equal(f.events.length, 1, "5초 뒤 같은 폴링에서 다시 알리지 않는다");
  await f.notify([a, b, c]);
  assert.equal(f.events.length, 2, "저장본과 메모리에 없는 새 계정만 알린다");
  assert.match(f.events[1].body, /later-chain/);
  await f.notify([a, account("new-chain", 2), c]);
  assert.equal(f.events.length, 3, "재인증으로 만료가 바뀐 사슬은 다시 알린다");
  assert.match(f.events[2].body, /new-chain/);
  assert.equal(f.stored(), record([a]), "실패한 쓰기는 저장소를 바꾸지 않았다");
});

test("V4: successful storage remembers a chain across module reloads and prunes old keys", async (t) => {
  const a = account("saved-chain");
  const f = await fixture(t, null);
  await f.notify([a]);
  assert.equal(f.events.length, 1);
  assert.equal(f.stored(), record([a]));
  const reloaded = await f.reload();
  await reloaded([a]);
  assert.equal(f.events.length, 1);
  await reloaded([]);
  assert.equal(f.stored(), "[]");
});

test("V4: unreadable storage still remembers expiry notifications in memory", async (t) => {
  const f = await fixture(t, null, { failRead: true, failWrite: true });
  await f.notify([account("memory-chain")]);
  await f.notify([account("memory-chain")]);
  assert.equal(f.events.length, 1);
});

test("V4: a matching persisted empty snapshot also clears the process record", async (t) => {
  const a = account("leaves-window");
  const f = await fixture(t, "[]", { failWrite: true });
  await f.notify([a]);
  await f.notify([]);
  await f.notify([a]);
  assert.equal(f.events.length, 2, "예고 창에서 빠진 사슬은 기존 정책대로 기록에서 빠진다");
});
