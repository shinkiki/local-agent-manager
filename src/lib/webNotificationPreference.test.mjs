import assert from "node:assert/strict";
import test from "node:test";
import { deviceNotificationsEnabled } from "./webNotificationPreference.ts";

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
