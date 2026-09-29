import assert from "node:assert/strict";
import test from "node:test";
import { closesMarkdownFence, markdownFenceLanguage, markdownFenceOpen } from "./markdownFences.ts";

test("물결 펜스도 백틱 펜스와 같이 다루고 종류가 맞아야 닫힌다", () => {
  assert.deepEqual(markdownFenceOpen("~~~ts"), { marker: "~~~", language: "ts", info: "ts" });
  assert.deepEqual(markdownFenceOpen("````"), { marker: "````", language: "", info: "" });
  assert.equal(markdownFenceOpen("~~취소~~"), null);

  assert.equal(closesMarkdownFence("~~~", "~~~"), true);
  // 백틱 펜스 안에 적힌 물결 줄이 코드 블록을 먼저 닫으면 뒤 내용이 본문으로 샌다.
  assert.equal(closesMarkdownFence("~~~", "```"), false);
  // 길게 연 펜스는 그 길이 이상으로만 닫힌다.
  assert.equal(closesMarkdownFence("```", "````"), false);
  assert.equal(closesMarkdownFence("`````", "````"), true);
});

// 정보 문자열을 한 낱말로 제한하던 때는 `flowchart LR` 같은 여는 줄이 펜스로 인식되지
// 않아 코드가 본문 문단으로 새어 나왔다. 첫 낱말은 언어로, 줄 전체는 info로 남아야 한다.
test("정보 문자열에 값이 붙은 여는 줄도 펜스로 읽는다", () => {
  assert.deepEqual(markdownFenceOpen("```flowchart LR"), { marker: "```", language: "flowchart", info: "flowchart LR" });
  assert.deepEqual(markdownFenceOpen("```js 설명"), { marker: "```", language: "js", info: "js 설명" });
  // 앞뒤 공백만 있는 정보 문자열은 언어가 없는 펜스와 같다.
  assert.deepEqual(markdownFenceOpen("```   "), { marker: "```", language: "", info: "" });
  // 백틱이 섞인 줄은 인라인 코드가 든 문단일 수 있으므로 펜스로 읽지 않는다.
  assert.equal(markdownFenceOpen("```a```"), null);
});

test("펜스 언어 이름은 정보 문자열의 첫 낱말이고 mermaid 판정도 같은 규칙을 쓴다", () => {
  assert.equal(markdownFenceLanguage("flowchart LR"), "flowchart");
  assert.equal(markdownFenceLanguage("  ts  "), "ts");
  assert.equal(markdownFenceLanguage(""), "");
  // 여는 줄을 읽는 쪽과 다이어그램을 가리는 쪽이 같은 낱말을 본다.
  assert.equal(markdownFenceOpen("```flowchart LR").language, markdownFenceLanguage("flowchart LR"));
});
