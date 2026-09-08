import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceNotificationsEnabled,
  deviceNotificationsOn,
  setDeviceNotifications,
} from "./webNotificationPreference.ts";

test("an existing browser grant restores notifications without a saved preference", () => {
  assert.equal(deviceNotificationsEnabled(null, "granted"), true);
});

test("an explicit off preference overrides an existing browser grant", () => {
  assert.equal(deviceNotificationsEnabled("off", "granted"), false);
});

test("an explicit on preference tolerates an unknown browser permission state", () => {
  assert.equal(deviceNotificationsEnabled("on", "default"), true);
});

test("a browser denial overrides an explicit on preference", () => {
  assert.equal(deviceNotificationsEnabled("on", "denied"), false);
});

/** 저장소를 흉내 낸 window. 저장 키를 아는 자리가 이 모듈뿐인지 여기서 확인한다. */
function withStorage(initial) {
  const store = new Map(Object.entries(initial));
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, value); },
    },
  };
  return store;
}

test("saving turns the preference into the stored value the reader uses", () => {
  const store = withStorage({});
  setDeviceNotifications(true);
  assert.equal(store.get("agentManager.deviceNotifications"), "on");
  assert.equal(deviceNotificationsOn("default"), true);
  setDeviceNotifications(false);
  assert.equal(store.get("agentManager.deviceNotifications"), "off");
  assert.equal(deviceNotificationsOn("granted"), false);
});

test("a missing stored preference falls back to the browser permission", () => {
  withStorage({});
  assert.equal(deviceNotificationsOn("granted"), true);
  assert.equal(deviceNotificationsOn("default"), false);
});

/** 쿠키를 전면 차단한 브라우저처럼 `window.localStorage`를 읽는 것만으로 예외가 나는 window. */
function withBlockedStorage() {
  globalThis.window = {
    get localStorage() {
      throw new Error("SecurityError: The operation is insecure.");
    },
  };
}

test("a blocked storage reads as no saved preference instead of throwing (QA #23)", () => {
  withBlockedStorage();
  assert.equal(deviceNotificationsOn("granted"), true);
  assert.equal(deviceNotificationsOn("default"), false);
});

test("a blocked storage turns saving into a no-op instead of throwing (QA #23)", () => {
  withBlockedStorage();
  assert.doesNotThrow(() => setDeviceNotifications(true));
  assert.doesNotThrow(() => setDeviceNotifications(false));
});
