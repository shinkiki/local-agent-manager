/// <reference types="cypress" />
/**
 * 영어 UI에서 워크플로 → 워크플로 관리 탭의 개요 패널(WorkflowOverview)과 목록 패널
 * (WorkflowCatalogList) 문구.
 *
 * 이 화면의 영어는 두 갈래로만 나온다 — 컴포넌트가 `text(ko, en)`으로 직접 고르거나, 정적 UI
 * 대응표 `STATIC_UI_EN`(src/lib/i18nStaticDictionary.ts)에 실려 치환기가 바꾸거나. 둘 중
 * 어디에도 없는 한국어 리터럴은 영어 화면에 한국어 그대로 남는다(staticUiText.ts:53
 * `staticEnglishFallback` — 문구 전체가 수량 표현일 때만 바꾸고 나머지는 원문을 돌려준다).
 *
 * WorkflowsView의 두 패널은 `useI18n`을 부르지 않고 한국어 리터럴만 그린다
 * (WorkflowsView.tsx:701-719 개요, WorkflowsView.tsx:733-741 목록). 대응표에 실린 것은
 * 개요 제목 "시스템 워크플로" 하나뿐이라, 영어 화면에서 제목만 영어로 서고 그 아래 설명·통계
 * 라벨·목록 머리말·빈 상태가 통째로 한국어로 남는다.
 *
 * 기존 워크플로 다국어 스펙 둘은 이 자리를 비켜 갔다.
 * - am20260908-workflow-delete-confirm-language: 삭제 확인창(모달)
 * - am20260907-pacing-switch-language: 페이싱 탭
 * 관리 탭을 연 첫 화면 자체는 어느 쪽도 영어로 확인한 적이 없다.
 *
 * 격리 하네스는 계약 0건이라 목록이 빈 상태로 그려진다 — 머리말·개수 배지·빈 상태 안내가
 * 한 화면에 모두 나오는 조건이다.
 */
const HANGUL = /[가-힣]/;

describe("영어 UI에서 워크플로 관리 탭 문구", () => {
  before(() => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.anchor("nav.workflows").should("not.contain.text", "워크플로");
  });

  after(() => {
    cy.restoreLanguage();
  });

  const openCatalog = () => {
    cy.visitApp();
    cy.openView("workflows");
    cy.anchor("workflows.tab.catalog").should("have.class", "active");
    cy.get(".workflow-overview").should("exist");
  };

  // 한국어 잔존 관찰이 "언어 전환 자체가 안 됐다"로 읽히지 않도록, 같은 화면에서 대응표를
  // 타는 문구가 영어로 바뀌었는지를 먼저 못 박는다.
  it("탭 줄과 개요 제목은 대응표를 타 영어로 선다", () => {
    openCatalog();

    cy.anchor("workflows.tab.catalog").should("not.contain.text", "워크플로");
    cy.anchor("workflows.tab.recurring").should("not.contain.text", "페이싱");
    cy.get(".workflow-overview h2").invoke("text").should("not.match", HANGUL);
    cy.get(".workflow-eyebrow").should("have.text", "AUTOMATION LIBRARY");
    cy.screenshot("workflow-catalog-english");
  });

  it("개요 설명과 통계 라벨도 영어로 선다", () => {
    openCatalog();

    cy.get(".workflow-overview-stats dt").eq(0).should("have.text", "Registered");
    cy.get(".workflow-overview-stats dt").eq(1).should("have.text", "Runnable");
    cy.get(".workflow-overview-stats dt").eq(2).should("have.text", "Paced rounds");
    cy.get(".workflow-overview-stats dt").eq(3).should("have.text", "Last succeeded");
    cy.get(".workflow-limit-summary dt").invoke("text").should("contain", "Contract safety limits");
    cy.get(".workflow-overview-actions .icon-button").first()
      .invoke("attr", "aria-label").should("equal", "Refresh");
  });

  it("목록 패널의 머리말·접근성 라벨·빈 상태도 영어로 선다", () => {
    openCatalog();

    cy.get(".workflow-catalog").invoke("attr", "aria-label").should("equal", "Workflow list");
    cy.get(".workflow-catalog .workflow-panel-heading strong").should("have.text", "Registered contracts");
    cy.get(".workflow-catalog .workflow-panel-heading em").should("have.text", "0");
    cy.get(".workflow-catalog-empty")
      .should("contain.text", "No workflows yet")
      .and("contain.text", "Describe the work you want automated to AIA.");
  });

  // QA #93 — 한때 이 두 패널은 `useI18n`을 아예 부르지 않아 제목 한 줄만 빼고 통째로
  // 한국어로 남았다. 숫자가 끼는 문장이라 정적 대응표로는 덮을 수 없어 컴포넌트가 언어마다
  // 문장을 통째로 들게 고쳤다.
  it("개요·목록 패널에 한국어가 남지 않는다", () => {
    openCatalog();

    cy.get(".workflow-overview").invoke("text").should("not.match", HANGUL);
    cy.get(".workflow-catalog").invoke("text").should("not.match", HANGUL);
    cy.get(".workflow-catalog").invoke("attr", "aria-label").should("not.match", HANGUL);
    cy.get(".workflow-overview-actions .icon-button").first()
      .invoke("attr", "aria-label").should("not.match", HANGUL);
    cy.get(".workflow-detail-empty").invoke("text").should("not.match", HANGUL);
  });

  it("한국어로 되돌리면 개요 제목도 원문으로 돌아온다", () => {
    cy.visitApp();
    cy.setLanguage("ko");
    openCatalog();

    cy.get(".workflow-overview h2").should("have.text", "시스템 워크플로");
    cy.get(".workflow-catalog .workflow-panel-heading strong").should("have.text", "등록된 계약");
  });
});
