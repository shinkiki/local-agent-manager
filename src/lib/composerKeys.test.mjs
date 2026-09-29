import assert from "node:assert/strict";
import test from "node:test";
import { enterSubmitsIn, isSoftKeyboardEnvironment, readComposerEnterMode, shouldSubmitOnEnter, writeComposerEnterMode } from "./composerKeys.ts";

test("plain Enter sends the message", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter" }), true);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: false }), true);
});

test("Shift+Enter keeps the line break", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter", shiftKey: true }), false);
});

test("other modifiers never send", () => {
  for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
    assert.equal(shouldSubmitOnEnter({ key: "Enter", [modifier]: true }), false, modifier);
  }
});

test("IME composition Enter only commits the composition", () => {
  assert.equal(shouldSubmitOnEnter({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Enter", keyCode: 229 }), false);
});

test("other keys are untouched", () => {
  assert.equal(shouldSubmitOnEnter({ key: "a" }), false);
  assert.equal(shouldSubmitOnEnter({ key: "Escape" }), false);
});

test("touch devices with a soft keyboard keep Enter as a line break", () => {
  const phone = (query) => query === "(pointer: coarse)" || query === "(hover: none)" || query === "(max-width: 760px)";
  assert.equal(isSoftKeyboardEnvironment(phone, 5), true);
  assert.equal(isSoftKeyboardEnvironment(phone, 0), true);
});

test("narrow desktop windows still send on Enter", () => {
  const narrowDesktop = (query) => query === "(max-width: 760px)";
  assert.equal(isSoftKeyboardEnvironment(narrowDesktop, 0), false);
  const desktop = () => false;
  assert.equal(isSoftKeyboardEnvironment(desktop, 0), false);
});

test("touch laptop with a real keyboard sends on Enter at desktop width", () => {
  const touchLaptop = (query) => query === "(pointer: coarse)";
  assert.equal(isSoftKeyboardEnvironment(touchLaptop, 10), false);
});

test("Enter mode overrides the soft-keyboard guess in both directions", () => {
  assert.equal(enterSubmitsIn("auto", true), false);
  assert.equal(enterSubmitsIn("auto", false), true);
  assert.equal(enterSubmitsIn("send", true), true, "iPad with a hardware keyboard still looks coarse");
  assert.equal(enterSubmitsIn("newline", false), false);
});

test("stored Enter mode falls back to auto for unknown or missing values", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readComposerEnterMode(storage), "auto");
  writeComposerEnterMode("send", storage);
  assert.equal(readComposerEnterMode(storage), "send");
  values.set("agent-manager.composer-enter-mode", "bogus");
  assert.equal(readComposerEnterMode(storage), "auto");
  assert.equal(readComposerEnterMode(null), "auto");
});
