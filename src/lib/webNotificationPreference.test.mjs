import assert from "node:assert/strict";
import test from "node:test";
import {
  deviceNotificationsEnabled,
  deviceNotificationsOn,
  setDeviceNotifications,
} from "./webNotificationPreference.ts";
import { useBlockedStorageWindow, useStorageWindow } from "./storedTextFixtures.mjs";

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

/** 저장 키를 아는 자리가 이 모듈뿐인지, 저장된 원문을 그대로 보아 확인한다. */
test("saving turns the preference into the stored value the reader uses", () => {
  const store = useStorageWindow();
  setDeviceNotifications(true);
  assert.equal(store.get("agentManager.deviceNotifications"), "on");
  assert.equal(deviceNotificationsOn("default"), true);
  setDeviceNotifications(false);
  assert.equal(store.get("agentManager.deviceNotifications"), "off");
  assert.equal(deviceNotificationsOn("granted"), false);
});

test("a missing stored preference falls back to the browser permission", () => {
  useStorageWindow();
  assert.equal(deviceNotificationsOn("granted"), true);
  assert.equal(deviceNotificationsOn("default"), false);
});

test("a blocked storage reads as no saved preference instead of throwing (QA #23)", () => {
  useBlockedStorageWindow();
  assert.equal(deviceNotificationsOn("granted"), true);
  assert.equal(deviceNotificationsOn("default"), false);
});

test("a blocked storage turns saving into a no-op instead of throwing (QA #23)", () => {
  useBlockedStorageWindow();
  assert.doesNotThrow(() => setDeviceNotifications(true));
  assert.doesNotThrow(() => setDeviceNotifications(false));
});
