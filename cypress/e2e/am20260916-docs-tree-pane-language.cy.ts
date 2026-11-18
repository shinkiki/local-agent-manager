/// <reference types="cypress" />
/**
 * 영어 UI에서 문서 트리 창(DocumentTreePane)의 검색 입력과 빈 상태 문구.
 *
 * 문서 화면의 영어 문구는 두 갈래로 나온다 — 컴포넌트가 `text(ko, en)`으로 직접 고르거나,
 * 정적 UI 치환기(src/lib/i18nStaticUi.tsx)의 대응표 `STATIC_UI_EN`에 실려 화면에서 바뀌거나.
 * 둘 중 어디에도 없는 한국어 리터럴은 영어 화면에 한국어 그대로 남는다
 * (i18nStaticUi.tsx:279 `staticEnglish` — 짝이 없으면 원문을 돌려준다).
 *
 * 기존 문서 다국어 스펙 둘은 이 창을 비켜 갔다.
 * - am20260906-docs-language: 주 메뉴·등록 폴더 사이드바·섹션 탭(DocsView)
 * - docs-file-pane-language: 파일을 고르기 전 빈 상태와 미리보기 불가 안내(DocumentFilePane, QA #58)
 * 가운데 창인 트리 창은 등록 폴더를 고른 뒤에만 그려져 두 스펙 모두 지나친 자리다. 이 창은
 * `useI18n`을 아예 부르지 않고 한국어 리터럴만 그린다(DocumentTreePane.tsx:93·99·100·155).
 *
 * 등록 폴더를 남기면 "폴더 0건"을 전제로 하는 다른 문서 스펙이 무너지므로 이 스펙 안에서 되돌린다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

describe("영어 UI에서 문서 트리 창 문구", () => {
  const target = `/tmp/am-e2e-doctreelang-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
    cy.exec(`printf 'a' > ${target}/alpha-note.md`);
  });

  after(() => {
    cy.restoreLanguage();
    cleanupDocRoot(target);
  });

  const openTree = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.setLanguage("en");
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  // 트리 창이 한국어로 남았다는 관찰이 "언어 전환 자체가 안 됐다"로 읽히지 않도록, 같은
  // 화면에서 대응표를 타는 문구가 영어로 바뀌었는지를 먼저 못 박는다.
  it("등록 폴더를 고른 뒤에도 문서 화면의 대응표 문구는 영어로 서 있다", () => {
    openTree();

    cy.anchor("docs.sidebar").should("contain.text", "Registered folders");
    cy.view("docs").find(".docs-section-tabs button").eq(0).should("have.text", "Browse");
    cy.screenshot("docs-tree-pane-english");
  });

  // QA #86 — 이 창은 등록 폴더를 고른 뒤에만 그려져 앞선 두 문서 화면 번역(AM-79·AM-213)의
  // 재현 경로 밖에 있었고, 그래서 네 자리가 대응표에도 `text(ko, en)`에도 없이 한국어로
  // 남아 있었다. 같은 파일의 다른 문서 컴포넌트와 같은 모양(`text(ko, en)`)으로 닫았다.
  it("트리 창의 검색 입력과 빈 상태 문구도 영어로 나온다", () => {
    openTree();

    cy.get(".document-tree-pane").invoke("attr", "aria-label").should("not.match", /[가-힣]/);
    cy.get(".document-tree-search input").invoke("attr", "placeholder").should("not.match", /[가-힣]/);
    cy.get(".document-tree-search input").invoke("attr", "aria-label").should("not.match", /[가-힣]/);

    cy.get(".document-tree-search input").type("zzz-no-match-zzz");
    cy.get(".document-search-results", { timeout: 10000 }).should("be.visible");
    cy.contains(".document-search-results .tree-empty", /./, { timeout: 10000 })
      .invoke("text").should("not.match", /[가-힣]/);
  });
});
