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

test("third-language translations reverse to the first source that declared them", () => {
  // 같은 번역값을 여러 원문이 가지면 먼저 선언된 원문으로 되짚는다. 표를 훑던 시절의
  // `find`와 같은 답이어야 되짚은 원문이 조용히 다른 문장으로 바뀌지 않는다.
  const messages = { "권한 모드": "Modo de permiso", "승인 방식": "Modo de permiso" };
  assert.equal(canonicalSourceText(" Modo de permiso ", messages, new Map()), " 권한 모드 ");
  // 정적 카탈로그가 먼저다 — 번역표에 같은 글자가 있어도 카탈로그 쪽 원문을 쓴다.
  const catalog = new Map([["Modo de permiso", "권한 모드(카탈로그)"]]);
  assert.equal(canonicalSourceText("Modo de permiso", messages, catalog), "권한 모드(카탈로그)");
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

// 애드온 탭은 공급자를 "클로드"라는 한국어 라벨로 따로 부른다. 그 짝이 생성 카탈로그에
// 실리면서(2026-09-20, 카탈로그를 소스에서 뽑기 시작) 역방향 표에 `Claude → 클로드`가
// 생겼고, `sourceName`이 그린 영어 정본 `Claude`가 한국어 화면에서 되짚기에 걸려
// "클로드"로 바뀌었다 — 세션 참조 공급자 칩·대시보드·세션 목록이 모두 같은 자리다.
// 고유명사는 번역문이 아니라 화면이 처음부터 그렇게 그린 값이라 되짚을 원문이 없다.
test("고유명사는 역방향 표에 걸려도 되짚지 않는다", () => {
  const withProperNouns = new Map([
    ...staticKoreanByEnglish,
    ["Claude", "클로드"],
    ["Codex", "코덱스"],
    ["Antigravity", "안티그라비티"],
  ]);
  for (const name of ["Claude", "Codex", "Antigravity"]) {
    assert.equal(canonicalSourceText(name, {}, withProperNouns), name);
    // 앞뒤 공백도 그대로다 — 칩은 `<input/>{" "}Claude`로 그려 공백이 붙는다.
    assert.equal(canonicalSourceText(` ${name}`, {}, withProperNouns), ` ${name}`);
  }
  // 제3언어 번역의 역방향도 마찬가지다.
  assert.equal(canonicalSourceText("Claude", { "클로드": "Claude" }, new Map()), "Claude");
  // 고유명사가 아닌 문구는 지금까지처럼 되짚는다.
  assert.equal(canonicalSourceText("Permission mode", {}, withProperNouns), "권한 모드");
});
