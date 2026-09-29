import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownChunks } from "./markdownChunks.ts";

// 분할기가 펜스 문법을 그대로 쓰는지 본다. 여기서 문법을 다시 적으면 `flowchart LR` 같은
// 여는 줄이 펜스로 인식되지 않아 코드가 본문 문단으로 새어 나온다.
test("정보 문자열에 값이 붙은 여는 줄도 한 덩어리로 담는다", () => {
  const { chunks, fences } = splitMarkdownChunks("```flowchart LR\nA --> B\n```");
  assert.equal(chunks.length, 1);
  assert.deepEqual(fences.map((fence) => [fence.language, fence.info, fence.code]), [["flowchart", "flowchart LR", "A --> B"]]);
});

test("물결 펜스 안의 빈 줄에서도 자르지 않는다", () => {
  const { chunks, fences } = splitMarkdownChunks("~~~ts\n\n\nx\n~~~");
  assert.equal(chunks.length, 1);
  assert.deepEqual(fences.map((fence) => [fence.language, fence.code]), [["ts", "\n\nx"]]);
});

test("백틱 펜스 안의 물결 줄은 펜스를 닫지 않는다", () => {
  const { fences } = splitMarkdownChunks("```text\n~~~\n```\n\n뒤 문단");
  assert.deepEqual(fences.map((fence) => fence.code), ["~~~"]);
});

const linesOf = (text) => text.split("\n");

test("덩어리의 start는 원문 줄 위치와 정확히 맞는다", () => {
  const source = "첫 문단\n이어짐\n\n# 제목\n\n```ts\nx\n\ny\n```\n뒤\n\n- 항목";
  const lines = linesOf(source);
  for (const chunk of splitMarkdownChunks(source).chunks) {
    const own = linesOf(chunk.text);
    assert.deepEqual(
      lines.slice(chunk.start, chunk.start + own.length),
      own,
      "start가 어긋나면 제목 섹션 복사가 다른 줄을 집는다",
    );
  }
});

test("펜스 안의 빈 줄에서는 자르지 않는다", () => {
  const { chunks } = splitMarkdownChunks("```ts\n\n\n```");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "```ts\n\n\n```");
});

test("닫히지 않은 펜스는 문서 끝까지 한 덩어리다", () => {
  const { chunks } = splitMarkdownChunks("앞\n\n```py\nx = 1\n\ny = 2");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].text, "```py\nx = 1\n\ny = 2");
});

test("문서가 자라도 완성된 앞 덩어리는 문자열이 그대로다", () => {
  // 이 성질이 깨지면 덩어리 memo가 매번 무효화되어 스트리밍 비용이 다시 제곱으로 돈다.
  const full = "문단 하나\n\n# 제목\n본문\n\n- 항목 하나\n- 항목 둘\n\n```ts\nconst a = 1;\n```\n\n마지막 문단";
  let previous = [];
  for (let length = 1; length <= full.length; length += 1) {
    const chunks = splitMarkdownChunks(full.slice(0, length)).chunks;
    const settled = chunks.slice(0, -1);
    for (let index = 0; index < Math.min(settled.length, previous.length); index += 1) {
      assert.equal(settled[index].text, previous[index].text, `${length}자 시점에 ${index}번 덩어리가 바뀌었다`);
      assert.equal(settled[index].start, previous[index].start, `${length}자 시점에 ${index}번 덩어리 위치가 바뀌었다`);
    }
    if (settled.length >= previous.length) previous = settled;
  }
  assert.ok(previous.length >= 3, "완성된 덩어리가 쌓여야 검증이 의미 있다");
});

test("빈 문서와 공백 문서는 덩어리가 없다", () => {
  assert.deepEqual(splitMarkdownChunks("").chunks, []);
  assert.deepEqual(splitMarkdownChunks("\n\n  \n").chunks, []);
});

test("aia-command 펜스를 문서 순서대로 모은다", () => {
  const { fences } = splitMarkdownChunks("```aia-command\n첫\n```\n\n```ts\nx\n```\n\n```aia-command\n둘\n```");
  assert.deepEqual(fences.map((fence) => [fence.line, fence.language, fence.code]), [
    [0, "aia-command", "첫"],
    [4, "ts", "x"],
    [8, "aia-command", "둘"],
  ]);
});
