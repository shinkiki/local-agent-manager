import assert from "node:assert/strict";
import test from "node:test";

import { phraseText } from "./phrase.ts";

test("en이 null인 표기는 언어 선택 함수를 거치지 않는다", () => {
  const asked = [];
  const text = (ko, en) => { asked.push([ko, en]); return en; };

  // 고유명은 언어와 무관하게 ko를 그대로 쓴다 — 번역 카탈로그를 아예 타지 않는다.
  assert.equal(phraseText({ ko: "AIA", en: null }, text), "AIA");
  assert.deepEqual(asked, []);

  assert.equal(phraseText({ ko: "채팅", en: "Chat" }, text), "Chat");
  assert.deepEqual(asked, [["채팅", "Chat"]]);
});

test("빈 영문 표기는 고유명이 아니므로 그대로 선택 함수에 넘긴다", () => {
  // null만이 "번역하지 않는다"는 뜻이다. 빈 문자열을 같이 다루면 번역이 아직 비어 있는
  // 문구가 조용히 한국어로 굳어, 카탈로그에 영문을 채워도 바뀌지 않는다.
  assert.equal(phraseText({ ko: "세션", en: "" }, (_ko, en) => en), "");
});
