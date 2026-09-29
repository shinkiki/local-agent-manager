import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_CLOSE_CONFIRMATION_KEY,
  hideChatCloseConfirmation,
  shouldConfirmChatClose,
} from "./chatCloseConfirmation.ts";

test("chat close confirmation remains enabled until the preference is hidden", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(shouldConfirmChatClose(storage), true);
  hideChatCloseConfirmation(storage);
  assert.equal(values.get(CHAT_CLOSE_CONFIRMATION_KEY), "hidden");
  assert.equal(shouldConfirmChatClose(storage), false);
});

test("chat close confirmation fails safe when preference storage is unavailable", () => {
  const blocked = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };

  assert.equal(shouldConfirmChatClose(blocked), true);
  assert.doesNotThrow(() => hideChatCloseConfirmation(blocked));
});

test("chat close confirmation keeps asking when there is no storage at all", () => {
  assert.equal(shouldConfirmChatClose(null), true);
  assert.doesNotThrow(() => hideChatCloseConfirmation(null));
});
