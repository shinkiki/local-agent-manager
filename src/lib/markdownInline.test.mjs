import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKDOWN_INLINE_TOKEN,
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

test("토큰과 되돌림이 같은 문자 집합을 이스케이프로 본다", () => {
  // 두 규칙이 같은지는 문자 범위를 눈으로 대조해야만 알 수 있었다. ASCII 전 범위를
  // 훑어 두면 한쪽만 넓어지는 어긋남(본문에서는 사라진 백슬래시가 링크 주소에만 남는 것)이
  // 통과할 수 없다.
  for (let code = 0x21; code <= 0x7e; code += 1) {
    const char = String.fromCharCode(code);
    const escapable = !/[0-9A-Za-z]/.test(char);
    assert.deepEqual(tokens(`a\\${char}b`), escapable ? [`\\${char}`] : [], char);
    assert.equal(unescapeMarkdown(`a\\${char}b`), escapable ? `a${char}b` : `a\\${char}b`, char);
  }
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

test("표기가 아닌 부등호는 토큰으로 잡지 않는다", () => {
  // 덩이를 잡는 규칙은 여기, 잡은 덩이의 정체를 가르는 규칙은 markdownAngle에 있다.
  assert.deepEqual(tokens("n < m 이고 m > k"), []);
  assert.deepEqual(tokens("<https://example.com> 참고"), ["<https://example.com>"]);
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
