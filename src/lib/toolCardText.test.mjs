import assert from "node:assert/strict";
import test from "node:test";
import {
  boundToolCardText,
  formatCharCount,
  MAX_TOOL_CARD_TEXT_CHARS,
  TOOL_CARD_PREVIEW_SOURCE_CHARS,
  toolCardPreviewSource,
} from "./toolCardText.ts";

test("text within the limit is returned untouched", () => {
  const text = "x".repeat(MAX_TOOL_CARD_TEXT_CHARS);
  assert.deepEqual(boundToolCardText(text, "head"), { text, omitted: 0, total: text.length });
  assert.deepEqual(boundToolCardText(text, "tail"), { text, omitted: 0, total: text.length });
});

test("a finished card keeps the head and a running card keeps the tail", () => {
  const text = "A".repeat(10) + "B".repeat(10);
  assert.deepEqual(boundToolCardText(text, "head", 10), { text: "A".repeat(10), omitted: 10, total: 20 });
  assert.deepEqual(boundToolCardText(text, "tail", 10), { text: "B".repeat(10), omitted: 10, total: 20 });
});

test("the preview source never exceeds its bound", () => {
  const short = "{\"command\":\"ls\"}";
  assert.equal(toolCardPreviewSource(short), short);
  const long = "y".repeat(TOOL_CARD_PREVIEW_SOURCE_CHARS * 3);
  assert.equal(toolCardPreviewSource(long).length, TOOL_CARD_PREVIEW_SOURCE_CHARS);
});

test("character counts read in 만 above ten thousand", () => {
  assert.equal(formatCharCount(950), "950");
  assert.equal(formatCharCount(32_000), "3.2만");
  assert.equal(formatCharCount(498_110), "50만");
});
