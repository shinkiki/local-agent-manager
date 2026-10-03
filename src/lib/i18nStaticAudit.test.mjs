import assert from "node:assert/strict";
import test from "node:test";
import { auditStaticUi } from "../../scripts/check-i18n-static-ui.mjs";

test("M4 static UI audit measures catalog gaps and declares prompt exclusions", () => {
  const report = auditStaticUi();
  assert.ok(report.counts.textKeys > 0);
  assert.ok(report.counts.dictionaryKeys > 0);
  assert.ok(report.counts.missingCatalog > 0);
  assert.ok(report.counts.missingCatalog <= report.counts.unwrappedKorean);
  // 2026-10-02: `0ca36072` 가 감사기(`scripts/check-i18n-static-ui.mjs`)에만
  // `projectAiaHandoff.ts`·`projectMenuConformance.ts` 두 줄을 더하고 이 기대값은 그대로
  // 두어, 개발선에서 이 시험 하나가 깨진 채로 돌고 있었다. 예외 목록은 "화면 글이 아닌
  // 한국어 문자열"의 선언이라 사람이 읽고 넘겨야 하는 것이므로, 양쪽을 한 벌로 고정해
  // 한쪽만 고친 사람에게 다른 쪽도 고치라고 말하게 둔다.
  assert.deepEqual(report.exclusions, [
    "src/lib/skillTransfer.ts",
    "src/lib/schemaDiscoveryPrompts.ts",
    "src/lib/roundDesign.ts",
    "src/lib/projectAiaHandoff.ts",
    "src/lib/projectMenuConformance.ts",
  ]);
  // 2026-09-27: Windows 에서 path.relative 가 역슬래시를 돌려줘 예외가 한 건도 걸리지 않았다.
  // 예외 파일의 문구가 실제로 빠졌는지 수로 본다.
  assert.ok(report.counts.excludedPromptLiterals > 0);
});

/**
 * DOM 밖으로 나가는 문구(알림·창 제목·트레이 메뉴)는 치환기가 닿지 못해 따로 옮겨야 한다.
 * 마지막 남은 자리였던 트레이 메뉴가 문구 표로 옮겨 가면서(`65fd8e7c`) 이제 한 자리도
 * 남지 않았다 — 그전까지 이 시험은 "트레이만은 아직 남아 있다"를 적어 두는 표식이었고,
 * 그 자리가 정리되자 표식이 거짓이 되어 개발선에서 실패했다. 남은 자리가 없다는 사실
 * 자체를 고정해, 새 싱크가 생기면 그 위치가 실패 메시지에 그대로 찍히게 한다.
 */
test("M4 static UI audit leaves no unresolved outside-DOM sink", () => {
  assert.deepEqual(reportLocations(auditStaticUi()), []);
});

function reportLocations(report) {
  return report.outsideDom.map(({ location }) => location);
}
