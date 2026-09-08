import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSourceText, sendableUiCatalogSource, staticEnglishFallback } from "./staticUiText.ts";

const staticKoreanByEnglish = new Map([
  ["", "개"],
  ["Permission mode", "권한 모드"],
]);

test("whitespace-only React nodes are not reverse-translated to a unit label", () => {
  assert.equal(canonicalSourceText(" ", {}, staticKoreanByEnglish), " ");
});

test("non-empty translated text still resolves to its Korean source", () => {
  assert.equal(
    canonicalSourceText(" Permission mode ", {}, staticKoreanByEnglish),
    " 권한 모드 ",
  );
});

test("plain counts are not reverse-translated into another label's unit", () => {
  // 제3언어 번역값이 `${n}회` → `${n}`처럼 숫자뿐이어도, 화면의 개수 노드는 그대로 두어야 한다.
  const messages = { "3회": "3", "2개": "2" };
  assert.equal(canonicalSourceText("3", messages, staticKoreanByEnglish), "3");
  assert.equal(canonicalSourceText(" 2 ", messages, staticKoreanByEnglish), " 2 ");
  assert.equal(canonicalSourceText(" / 3", messages, staticKoreanByEnglish), " / 3");
});

test("component-declared English is left as the component rendered it", () => {
  // 카탈로그에 "관리 대상 전체" → "All managed storage"가 있어도, 컴포넌트가
  // text("관리 대상 전체", "All managed data")로 그린 노드는 되짚어 덮지 않는다(QA #5·#6).
  const catalog = new Map([["All managed storage", "관리 대상 전체"]]);
  assert.equal(canonicalSourceText("All managed data", {}, catalog), "All managed data");
  // 카탈로그 영어와 글자까지 같으면 되짚어도 같은 영어로 돌아오므로 화면은 바뀌지 않는다.
  assert.equal(canonicalSourceText("All managed storage", {}, catalog), "관리 대상 전체");
});

test("catalog sources with control characters or over 512 UTF-8 bytes are not sendable (QA #18/#21)", () => {
  // 백엔드 `validate_ui_catalog`는 key.len() > 512(바이트)·char::is_control·빈 문구를 거절한다.
  assert.equal(sendableUiCatalogSource("권한 모드"), true);
  assert.equal(sendableUiCatalogSource(""), false);
  assert.equal(sendableUiCatalogSource("   "), false);
  assert.equal(sendableUiCatalogSource("첫 줄\n둘째 줄"), false);
  assert.equal(sendableUiCatalogSource("탭\t문자"), false);
  assert.equal(sendableUiCatalogSource("줄바꿈\r복귀"), false);
  // 한글 170자 = 510바이트는 통과, 171자 = 513바이트는 거절. 글자 수가 아니라 바이트로 잰다.
  assert.equal(sendableUiCatalogSource("가".repeat(170)), true);
  assert.equal(sendableUiCatalogSource("가".repeat(171)), false);
  // 512바이트 이하라도 제어 문자가 하나 있으면 거절한다.
  assert.equal(sendableUiCatalogSource(`${"가".repeat(10)}\n${"가".repeat(10)}`), false);
});

test("static English fallback only converts whole-string quantities (QA #51)", () => {
  assert.equal(staticEnglishFallback("3개"), "3");
  assert.equal(staticEnglishFallback("1,204개"), "1,204");
  assert.equal(staticEnglishFallback("12건"), "12 items");
  assert.equal(staticEnglishFallback("7개 세션"), "7 sessions");
  // 대응표에 없는 문장은 일부만 바꾸지 않고 한국어 그대로 둔다. 예전 규칙은
  // "활성 0 / 전체 0 · 다음 실행 순"을 "활성 0 / total 0 · 다음 실행 순"으로 섞어 놓았다.
  assert.equal(staticEnglishFallback("활성 0 / 전체 0 · 다음 실행 순"), "활성 0 / 전체 0 · 다음 실행 순");
  assert.equal(staticEnglishFallback("보완 응답 3건 · 최대 세션당 200건, 전체 4,000건 보관"), "보완 응답 3건 · 최대 세션당 200건, 전체 4,000건 보관");
  assert.equal(staticEnglishFallback("전체 세션"), "전체 세션");
});
