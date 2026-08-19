import assert from "node:assert/strict";
import test from "node:test";
import { normalizeChatEvent } from "./chatCompatibility.ts";

test("legacy queued messages default missing attachments to an empty list", () => {
  const event = normalizeChatEvent({
    type: "queue",
    items: [{ id: "legacy-queue", text: "기존 요청" }],
  });

  assert.equal(event.type, "queue");
  assert.deepEqual(event.items[0].attachments, []);
});

test("legacy user input defaults missing attachments to an empty list", () => {
  const event = normalizeChatEvent({
    type: "userInput",
    id: "legacy-user",
    text: "기존 요청",
  });

  assert.equal(event.type, "userInput");
  assert.deepEqual(event.attachments, []);
});

test("current attachment payloads are preserved", () => {
  const attachment = {
    id: "file-1",
    name: "screen.png",
    mediaType: "image/png",
    sizeBytes: 42,
    kind: "image",
  };
  const event = normalizeChatEvent({
    type: "queue",
    items: [{ id: "current-queue", text: "확인", attachments: [attachment] }],
  });

  assert.equal(event.type, "queue");
  assert.deepEqual(event.items[0].attachments, [attachment]);
});
