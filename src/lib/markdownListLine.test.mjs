import assert from "node:assert/strict";
import test from "node:test";
import {
  markdownListItem,
  markdownTaskItem,
  startsMarkdownListItem,
} from "./markdownListLine.ts";

/** 본문만 보는 시험을 위한 축약. 목록 줄이 아니면 null. */
const itemBody = (line, kind) => markdownListItem(line, kind)?.body ?? null;

/** 번호만 보는 시험을 위한 축약. 순서 있는 목록 줄이 아니면 null. */
const orderedStart = (line) => markdownListItem(line, "ordered")?.start ?? null;

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
        itemBody(line, kind) !== null,
        `줄 ${JSON.stringify(line)}에서 판정이 어긋나면 스캐너가 그 줄에 갇힌다`,
      );
    }
  });
}

test("마커 뒤가 비어도 빈 본문으로 소비한다", () => {
  assert.equal(itemBody("- ", "unordered"), "");
  assert.equal(itemBody("* ", "unordered"), "");
  assert.equal(itemBody("+ ", "unordered"), "");
  assert.equal(itemBody("1. ", "ordered"), "");
  assert.equal(itemBody("1) ", "ordered"), "");
  // 예전 `(.+)` 규칙은 공백이 둘일 때만 역추적으로 통과해 한 칸을 본문으로 넘겼다.
  // 이제는 `\s+`가 공백을 다 먹고 본문이 비므로, 앞뒤 공백이 본문에 새지 않는다.
  assert.equal(itemBody("-  ", "unordered"), "");
});

test("본문이 있는 목록 항목은 마커만 떼어낸다", () => {
  assert.equal(itemBody("- 항목", "unordered"), "항목");
  assert.equal(itemBody("  * 들여쓴 항목", "unordered"), "들여쓴 항목");
  assert.equal(itemBody("12. 열두째", "ordered"), "열두째");
  assert.equal(itemBody("3) 셋째", "ordered"), "셋째");
});

// 본문과 번호를 한 번의 매칭에서 함께 꺼내는 것이 이 진입점의 요점이다. 갈래마다 어떤 칸이
// 채워지는지를 한 자리에서 못박아, 정규식의 그룹 이름이 바뀌어도 조용히 null이 되지 않게 한다.
test("항목 한 줄에서 본문과 번호를 함께 읽는다", () => {
  assert.deepEqual(markdownListItem("  3) 셋째", "ordered"), { body: "셋째", start: 3 });
  assert.deepEqual(markdownListItem("- 항목", "unordered"), { body: "항목", start: null });
});

test("종류가 다른 마커는 서로 잡지 않는다", () => {
  assert.equal(itemBody("- 항목", "ordered"), null);
  assert.equal(itemBody("1. 항목", "unordered"), null);
});

test("마커에 공백이 붙지 않으면 목록이 아니다", () => {
  assert.equal(itemBody("-항목", "unordered"), null);
  assert.equal(itemBody("1.항목", "ordered"), null);
  assert.equal(itemBody("문단", "unordered"), null);
});

test("체크박스 항목의 상태와 본문을 나눈다", () => {
  assert.deepEqual(markdownTaskItem("[x] 완료"), { checked: true, body: "완료" });
  assert.deepEqual(markdownTaskItem("[X] 완료"), { checked: true, body: "완료" });
  assert.deepEqual(markdownTaskItem("[ ] 미완"), { checked: false, body: "미완" });
  assert.equal(markdownTaskItem("완료"), null);
  assert.equal(markdownTaskItem("[x]붙어있음"), null);
});

// 항목 사이를 빈 줄로 띄운 목록은 덩어리가 갈려 항목마다 다른 `<ol>`이 된다. 번호를 읽지
// 못하면 그 `<ol>`이 전부 1부터 다시 세어 `1. 2. 3.`이 `1. 1. 1.`로 보인다.
test("순서 있는 항목의 시작 번호를 읽는다", () => {
  assert.equal(orderedStart("1. 첫째"), 1);
  assert.equal(orderedStart("2. 둘째"), 2);
  assert.equal(orderedStart("  10) 열째"), 10);
  assert.equal(orderedStart("007. 일곱째"), 7);
  assert.equal(orderedStart("1. "), 1);
});

test("순서 없는 목록과 문단에서는 번호가 없다", () => {
  assert.equal(orderedStart("- 항목"), null);
  assert.equal(orderedStart("1.항목"), null);
  assert.equal(orderedStart("문단"), null);
});
