import assert from "node:assert/strict";
import test from "node:test";
import { localizedUiText } from "./i18nLocale.ts";

const english = (source) => `EN:${source}`;

test("한국어는 원문을 그대로 쓴다", () => {
  assert.equal(localizedUiText("ko", "대시보드", english, { "대시보드": "Dashboard" }), "대시보드");
});

test("영어는 카탈로그가 아니라 영어 정본을 쓴다", () => {
  assert.equal(localizedUiText("en", "대시보드", english, { "대시보드": "무시됨" }), "EN:대시보드");
});

test("제3언어는 카탈로그 값을 쓰고 없으면 영어 정본으로 떨어진다", () => {
  assert.equal(localizedUiText("ja", "대시보드", english, { "대시보드": "ダッシュボード" }), "ダッシュボード");
  assert.equal(localizedUiText("ja", "대시보드", english, {}), "EN:대시보드");
});

test("V4: 제3언어 번역은 상속된 속성을 무시하고 직접 등록된 문구와 빈 번역을 쓴다", () => {
  const messages = Object.create({ inherited: "상속된 번역" });
  for (const source of ["constructor", "toString", "__proto__", "hasOwnProperty", "inherited"]) {
    assert.equal(localizedUiText("ja", source, english, messages), `EN:${source}`);
  }

  const ownMessages = JSON.parse('{"constructor":"コンストラクタ","__proto__":"プロトタイプ","hasOwnProperty":""}');
  assert.equal(localizedUiText("ja", "constructor", english, ownMessages), "コンストラクタ");
  assert.equal(localizedUiText("ja", "__proto__", english, ownMessages), "プロトタイプ");
  assert.equal(localizedUiText("ja", "hasOwnProperty", english, ownMessages), "");
});
