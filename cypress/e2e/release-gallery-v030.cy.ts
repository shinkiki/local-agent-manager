/// <reference types="cypress" />
/**
 * v0.3.0 공개 게시용 앱 화면 갤러리. 다크 테마, 1440x900, 가짜 데모 데이터.
 *
 * 격리 백엔드는 비어 있으므로 화면이 읽는 조회를 모두 스텁으로 세운다. 실제 사람 이름·이메일·
 * 이 기계의 경로는 쓰지 않는다 — 경로는 `/workspace/...`, 주소는 `example.com`이다.
 * 영어 갤러리(am-031-en-*)는 release-gallery-en-*.cy.ts가 같은 테스트를 영어로 돌린다.
 * 실행: node scripts/e2e.mjs --spec "cypress/e2e/release-gallery-v030.cy.ts" --summary /tmp/am-gallery-summary.json
 */
import { applyGalleryLanguage, shoot, stubWorkspace, tr, visitDark, widenHeadlessWindow } from "../support/releaseGalleryFixtures";

describe("v0.3.0 공개용 화면 갤러리", () => {
  before(() => {
    widenHeadlessWindow();
    applyGalleryLanguage();
  });

  beforeEach(() => {
    cy.viewport(1440, 900);
    stubWorkspace();
  });

  it("dashboard", () => {
    visitDark();
    cy.openView("dashboard");
    cy.anchor("dashboard.account-usage").find(".account-usage-bar").should("have.length.greaterThan", 10);
    cy.view("dashboard").find(".recent-list button").should("have.length", 10);
    shoot("dashboard");
  });

  it("dashboard-activity", () => {
    visitDark();
    cy.openView("dashboard");
    cy.anchor("dashboard.account-usage").find(".account-usage-bar").should("have.length.greaterThan", 10);
    cy.view("dashboard").find(".weekly-chart:not(.account-usage-chart) .week-column").should("have.length", 12);
    cy.view("dashboard").contains(".panel h2", tr("최근 세션", "Recent sessions")).closest(".panel").scrollIntoView({ offset: { top: -24, left: 0 } });
    shoot("dashboard-activity");
  });
});
