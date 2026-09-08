import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKDOWN_INLINE_TOKEN,
  markdownAngleToken,
  markdownEscapedChar,
  markdownUnderscoreIsIntraword,
  unescapeMarkdown,
} from "./markdownInline.ts";

/** 스캐너가 실제로 하는 일과 같은 순서로 토큰을 뽑는다. */
const tokens = (text) => [...text.matchAll(MARKDOWN_INLINE_TOKEN)].map((match) => match[0]);

test("이스케이프는 가려진 글자만 남기고 표기를 열지 않는다", () => {
  // Codex가 주소를 감싸 보낼 때 붙는 표기. 백슬래시가 화면에 찍히면 안 된다.
  assert.deepEqual(tokens("source=copy\\_link"), ["\\_"]);
  assert.equal(markdownEscapedChar("\\_"), "_");

  // 이스케이프한 별표는 기울임을 열지 못한다.
  assert.deepEqual(tokens("\\*강조가 아님\\*"), ["\\*", "\\*"]);

  // 문장부호가 아닌 글자 앞의 백슬래시는 이스케이프가 아니라 글자 그대로다.
  assert.deepEqual(tokens("경로 C:\\temp"), []);
  assert.equal(markdownEscapedChar("**굵게**"), null);
});

test("같은 글자를 쓰는 강조는 긴 표기부터 통째로 잡는다", () => {
  // 짧은 갈래가 먼저 이기면 `***중요***`가 안쪽만 잡혀 양옆 별표가 글자로 남았다.
  assert.deepEqual(tokens("***중요***"), ["***중요***"]);
  assert.deepEqual(tokens("___중요___"), ["___중요___"]);
  assert.deepEqual(tokens("__강조__와 _기울임_"), ["__강조__", "_기울임_"]);
});

/** 스캐너가 표기로 인정하는 토큰만 남긴다(낱말 안의 `_`는 글자로 남는다). */
const emphasis = (text) => [...text.matchAll(MARKDOWN_INLINE_TOKEN)]
  .filter((match) => !markdownUnderscoreIsIntraword(text, match.index, match.index + match[0].length))
  .map((match) => match[0]);

test("낱말 안의 밑줄은 강조로 보지 않는다", () => {
  assert.deepEqual(emphasis("snake_case_name 값"), []);
  assert.deepEqual(emphasis("경로 /tmp/my_file_name.txt"), []);
  assert.deepEqual(emphasis("(_기울임_) 확인"), ["_기울임_"]);
  assert.deepEqual(emphasis("_문장 앞 강조_"), ["_문장 앞 강조_"]);
});

test("이미지 표기는 느낌표까지 한 토큰으로 잡는다", () => {
  // 느낌표가 토큰 밖에 남으면 화면에 `!`만 덩그러니 찍힌다.
  assert.deepEqual(tokens("![그림](a.png) 뒤"), ["![그림](a.png)"]);
  assert.deepEqual(tokens("[문서](a.md)"), ["[문서](a.md)"]);
});

test("아는 HTML 표기만 걷어내고 부등호는 글자로 남긴다", () => {
  assert.deepEqual(markdownAngleToken("<br>"), { kind: "break" });
  assert.deepEqual(markdownAngleToken("<br />"), { kind: "break" });
  assert.deepEqual(markdownAngleToken("<b>"), { kind: "markup" });
  assert.deepEqual(markdownAngleToken("</details>"), { kind: "markup" });
  assert.deepEqual(markdownAngleToken('<img src="a.png" />'), { kind: "markup" });
  assert.deepEqual(markdownAngleToken("<https://example.com>"), {
    kind: "autolink",
    href: "https://example.com",
  });
  // 모르는 태그는 숨기지 않는다. 무엇이 지워졌는지 화면만 보고 알 수 없기 때문이다.
  assert.equal(markdownAngleToken("<oai-mem-citation>"), null);
  assert.equal(markdownAngleToken("<3"), null);
  assert.deepEqual(tokens("n < m 이고 m > k"), []);
});

test("코드 스팬 안의 백슬래시는 손대지 않는다", () => {
  assert.deepEqual(tokens("`a\\_b`"), ["`a\\_b`"]);
});

test("링크 주소의 이스케이프만 실제 글자로 되돌린다", () => {
  assert.equal(
    unescapeMarkdown("https://app.notion.com/p/c8e2?v=08f2\\&source=copy_link"),
    "https://app.notion.com/p/c8e2?v=08f2&source=copy_link",
  );
  assert.equal(unescapeMarkdown("C:\\temp"), "C:\\temp");
});
