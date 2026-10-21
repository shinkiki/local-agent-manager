import assert from "node:assert/strict";
import test from "node:test";
import { readJsonPayload } from "./responsePayload.ts";

test("JSON 본문은 그대로 읽는다", async () => {
  assert.deepEqual(await readJsonPayload(new Response('{"ok":true}')), { ok: true });
});

test("비었거나 JSON이 아닌 본문은 null이다", async () => {
  assert.equal(await readJsonPayload(new Response("")), null);
  assert.equal(await readJsonPayload(new Response("<html>")), null);
  assert.equal(await readJsonPayload(new Response("<html>"), new AbortController().signal), null);
});

test("본문을 읽는 사이 신호가 끊기면 null로 삼키지 않고 다시 던진다", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"partial":'));
      controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason));
    },
  });
  const pending = readJsonPayload(new Response(body), controller.signal);
  controller.abort(new DOMException("timed out", "TimeoutError"));
  await assert.rejects(pending, { name: "TimeoutError" });
});
