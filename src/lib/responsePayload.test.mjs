import assert from "node:assert/strict";
import test from "node:test";
import { downloadRatio, readJsonPayload, readJsonPayloadWithProgress, responseBodyTotal } from "./responsePayload.ts";

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

// 진행을 알리며 읽기: 큰 세션 원문을 받는 동안 화면이 실제로 받은 비율을 보이는 근거다.
function streamedResponse(text, { chunkSize = 4, headers = {} } = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

test("본문을 조각으로 받으며 받은 바이트와 전체 크기를 알리고 JSON 을 그대로 돌려준다", async () => {
  const text = JSON.stringify({ title: "한글 원문", items: [1, 2, 3] });
  const total = new TextEncoder().encode(text).length;
  const seen = [];
  const value = await readJsonPayloadWithProgress(
    streamedResponse(text, { headers: { "content-length": String(total) } }),
    (progress) => seen.push(progress),
  );
  assert.deepEqual(value, { title: "한글 원문", items: [1, 2, 3] });
  assert.deepEqual(seen[0], { loaded: 0, total });
  assert.deepEqual(seen.at(-1), { loaded: total, total });
  assert.ok(seen.every((progress, index) => index === 0 || progress.loaded >= seen[index - 1].loaded), "받은 양은 줄지 않는다");
});

test("압축 응답이면 백엔드가 실은 압축 전 크기를 전체 크기로 쓴다", () => {
  assert.equal(responseBodyTotal(new Headers({ "content-length": "40", "content-encoding": "gzip", "x-uncompressed-length": "120" })), 120);
});

test("받은 양이 알린 크기를 넘으면 그때부터 전체 크기를 모른다고 알린다", async () => {
  const text = JSON.stringify({ items: Array.from({ length: 20 }, (_, index) => index) });
  const seen = [];
  await readJsonPayloadWithProgress(streamedResponse(text, { headers: { "content-length": "10" } }), (progress) => seen.push(progress));
  assert.equal(seen.at(-1).total, null);
  assert.ok(seen.every((progress) => progress.total === null || progress.loaded <= progress.total));
});

test("압축 전송이거나 크기가 없으면 전체 크기를 모른다고 답한다", () => {
  assert.equal(responseBodyTotal(new Headers({ "content-length": "120", "content-encoding": "gzip" })), null);
  assert.equal(responseBodyTotal(new Headers({})), null);
  assert.equal(responseBodyTotal(new Headers({ "content-length": "0" })), null);
  assert.equal(responseBodyTotal(new Headers({ "content-length": "120" })), 120);
});

test("비율은 전체 크기를 알 때만 있고 1 을 넘지 않는다", () => {
  assert.equal(downloadRatio(null), null);
  assert.equal(downloadRatio({ loaded: 10, total: null }), null);
  assert.equal(downloadRatio({ loaded: 25, total: 100 }), 0.25);
  assert.equal(downloadRatio({ loaded: 150, total: 100 }), 1);
});

test("진행을 알리며 읽어도 JSON 이 아니면 null 이다", async () => {
  assert.equal(await readJsonPayloadWithProgress(streamedResponse("<html>"), () => {}), null);
});
