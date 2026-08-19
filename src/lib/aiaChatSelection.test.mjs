import assert from "node:assert/strict";
import test from "node:test";
import { selectAiaChat } from "./aiaChatSelection.ts";

const chat = (chatId, state) => ({ chatId, state });

test("an explicitly targeted AIA chat wins over recency and phase", () => {
  const selected = selectAiaChat([
    chat("approval", "waitingApproval"),
    chat("latest", "ready"),
  ], "latest");
  assert.equal(selected?.chatId, "latest");
});

test("a pending approval wins when restoring without an explicit target", () => {
  const selected = selectAiaChat([
    chat("approval", "waitingApproval"),
    chat("latest", "ready"),
  ]);
  assert.equal(selected?.chatId, "approval");
});

test("the latest AIA chat remains the fallback", () => {
  const selected = selectAiaChat([
    chat("older", "ready"),
    chat("latest", "running"),
  ]);
  assert.equal(selected?.chatId, "latest");
  assert.equal(selectAiaChat([]), null);
});
