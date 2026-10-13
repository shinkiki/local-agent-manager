import assert from "node:assert/strict";
import test from "node:test";
import { generatedCatalogMatches } from "../../scripts/generate-ui-catalog.mjs";

const LF = 'export const GENERATED_UI_EN: Record<string, string> = {\n  "접기": "Collapse",\n};\n';

test("생성 카탈로그 비교는 체크아웃이 바꾼 줄끝을 내용 차이로 보지 않는다", () => {
  // core.autocrlf=true 로 받은 작업 트리는 이 파일을 CRLF 로 풀어 놓고 생성기는 LF 로 적는다.
  // 바이트로 비교하면 갓 받은 저장소에서 `npm run i18n:check` 가 늘 실패했다.
  assert.equal(generatedCatalogMatches(LF.replace(/\n/g, "\r\n"), LF), true);
  assert.equal(generatedCatalogMatches(LF, LF), true);
});

test("생성 카탈로그 비교는 문구가 실제로 달라지면 어긋났다고 말한다", () => {
  assert.equal(generatedCatalogMatches(LF.replace("Collapse", "Fold"), LF), false);
  assert.equal(generatedCatalogMatches("", LF), false);
});
