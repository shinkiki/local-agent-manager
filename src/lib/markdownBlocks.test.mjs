import assert from "node:assert/strict";
import test from "node:test";
import {
  closesMarkdownFence,
  markdownFenceOpen,
  markdownListItemBody,
  markdownTaskItem,
  splitMarkdownChunks,
  startsMarkdownListItem,
} from "./markdownBlocks.ts";

test("물결 펜스도 백틱 펜스와 같이 다루고 종류가 맞아야 닫힌다", () => {
  assert.deepEqual(markdownFenceOpen("~~~ts"), { marker: "~~~", language: "ts" });
  assert.deepEqual(markdownFenceOpen("````"), { marker: "````", language: "" });
  assert.equal(markdownFenceOpen("~~취소~~"), null);
  assert.equal(markdownFenceOpen("```js 설명"), null);

  assert.equal(closesMarkdownFence("~~~", "~~~"), true);
  // 백틱 펜스 안에 적힌 물결 줄이 코드 블록을 먼저 닫으면 뒤 내용이 본문으로 샌다.
  assert.equal(closesMarkdownFence("~~~", "```"), false);
  // 길게 연 펜스는 그 길이 이상으로만 닫힌다.
  assert.equal(closesMarkdownFence("```", "````"), false);
  assert.equal(closesMarkdownFence("`````", "````"), true);
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

// 스트리밍 중에는 마커까지만 도착한 줄(`"- "`)이 반드시 한 번은 화면에 들어온다. 진입 판정이
// 참인데 본문 매칭이 실패하면 스캐너가 그 줄을 소비하지 못해 무한 루프에 빠지므로, 두 판정이
// 항상 같이 움직이는지를 규칙으로 못박는다.
const MARKER_ONLY = ["- ", "* ", "+ ", "1. ", "1) ", "10. ", "  - ", "\t* "];
const WITH_BODY = ["- 항목", "* 항목", "+ 항목", "1. 항목", "2) 항목", "  - 들여쓴 항목"];
const NOT_LIST = ["", "문단", "-항목", "1.항목", "> 인용", "# 제목", "```"];

for (const kind of ["unordered", "ordered"]) {
  test(`진입 판정과 본문 매칭이 같은 규칙을 쓴다: ${kind}`, () => {
    for (const line of [...MARKER_ONLY, ...WITH_BODY, ...NOT_LIST]) {
      assert.equal(
        startsMarkdownListItem(line, kind),
        markdownListItemBody(line, kind) !== null,
        `줄 ${JSON.stringify(line)}에서 판정이 어긋나면 스캐너가 그 줄에 갇힌다`,
      );
    }
  });
}

test("마커 뒤가 비어도 빈 본문으로 소비한다", () => {
  assert.equal(markdownListItemBody("- ", "unordered"), "");
  assert.equal(markdownListItemBody("* ", "unordered"), "");
  assert.equal(markdownListItemBody("+ ", "unordered"), "");
  assert.equal(markdownListItemBody("1. ", "ordered"), "");
  assert.equal(markdownListItemBody("1) ", "ordered"), "");
  // 예전 `(.+)` 규칙은 공백이 둘일 때만 역추적으로 통과해 한 칸을 본문으로 넘겼다.
  // 이제는 `\s+`가 공백을 다 먹고 본문이 비므로, 앞뒤 공백이 본문에 새지 않는다.
  assert.equal(markdownListItemBody("-  ", "unordered"), "");
});

test("본문이 있는 목록 항목은 마커만 떼어낸다", () => {
  assert.equal(markdownListItemBody("- 항목", "unordered"), "항목");
  assert.equal(markdownListItemBody("  * 들여쓴 항목", "unordered"), "들여쓴 항목");
  assert.equal(markdownListItemBody("12. 열두째", "ordered"), "열두째");
  assert.equal(markdownListItemBody("3) 셋째", "ordered"), "셋째");
});

test("종류가 다른 마커는 서로 잡지 않는다", () => {
  assert.equal(markdownListItemBody("- 항목", "ordered"), null);
  assert.equal(markdownListItemBody("1. 항목", "unordered"), null);
});

test("마커에 공백이 붙지 않으면 목록이 아니다", () => {
  assert.equal(markdownListItemBody("-항목", "unordered"), null);
  assert.equal(markdownListItemBody("1.항목", "ordered"), null);
  assert.equal(markdownListItemBody("문단", "unordered"), null);
});

test("체크박스 항목의 상태와 본문을 나눈다", () => {
  assert.deepEqual(markdownTaskItem("[x] 완료"), { checked: true, body: "완료" });
  assert.deepEqual(markdownTaskItem("[X] 완료"), { checked: true, body: "완료" });
  assert.deepEqual(markdownTaskItem("[ ] 미완"), { checked: false, body: "미완" });
  assert.equal(markdownTaskItem("완료"), null);
  assert.equal(markdownTaskItem("[x]붙어있음"), null);
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
