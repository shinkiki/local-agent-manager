/// <reference types="cypress" />
import { cleanupDocRoot } from "../support/docRootFixtures";
// 문서 화면의 "변경 자동화" 섹션.
// 기존 am20260906-docs-automation-empty는 감시할 폴더가 없을 때의 빈 상태 안내만 확인했다.
// 여기서는 임시 폴더를 등록한 후 변경 자동화 패널로 진입했을 때 빈 상태 대신 트리거 등록 폼이
// 정상적으로 노출되는지, 폼 기본값(감시 폴더 매핑, 포함 패턴 '**/*', 변경 종류 3개 체크)이
// 올바른지, 그리고 필수 입력값(이름 누락, 변경 종류 미선택, 채팅 요청 프롬프트 누락) 검증 시
// 오류 배너가 정확히 뜨는지를 화면에서 검증한다.

describe("문서 변경 자동화 · 폴더 등록 후 폼 노출 및 입력값 검증", () => {
  const targetDir = `/tmp/am-e2e-doctrigger-${Date.now()}`;
  const tabs = () => cy.view("docs").find(".docs-section-tabs button");

  before(() => {
    // 임시 폴더 생성
    cy.exec(`mkdir -p ${targetDir}`);
  });

  after(() => {
    // 테스트 후 등록된 임시 등록 폴더 해제 및 로컬 디렉터리 정리
    cleanupDocRoot(targetDir);
  });

  it("폴더 등록 후 변경 자동화 폼이 열리고 필수값 미입력 시 오류 배너로 안내한다", () => {
    cy.visitApp();
    cy.openView("docs").should("be.visible");

    // 1. 폴더가 없는 초기 상태 확인
    tabs().eq(1).click();
    cy.view("docs").find(".document-automation-panel").should("be.visible");
    cy.get(".document-trigger-form .tree-empty").should(
      "contain.text",
      "감시할 등록 폴더가 없습니다",
    );
    cy.get(".document-trigger-grid").should("not.exist");

    // 2. 사이드바에서 임시 폴더 등록
    cy.get('[aria-label="등록 폴더 추가"]').first().click({ force: true });
    cy.get(".root-form input").eq(1).type(targetDir);
    cy.contains(".root-form button", "폴더 등록").click();
    cy.get(".root-form").should("not.exist");
    cy.get(".root-row").should("have.length", 1);

    // 3. 파일 탭에서 변경 자동화 탭으로 다시 이동 시 등록 폼 노출 및 기본값 확인
    tabs().eq(0).click();
    tabs().eq(1).click();
    cy.get(".document-trigger-form header strong").should("contain.text", "파일 트리거 등록");
    cy.get(".document-trigger-grid").should("be.visible");

    // 감시 폴더 select에 등록된 임시 폴더가 기본 선택되어 있어야 한다
    cy.get(".document-trigger-grid select").first().should("be.visible");
    cy.get(".document-trigger-grid textarea").first().should("have.value", "**/*");

    // 변경 종류 체크박스 3개 모두 체크되어 있어야 한다
    cy.get(".document-trigger-form fieldset input[type=\"checkbox\"]").should("have.length", 3).each(($el) => {
      expect($el).to.be.checked;
    });

    // 4. 경계조건 검증 1: 이름 미입력 상태에서 등록 시도
    cy.get(".document-trigger-form-actions button.primary").click();
    cy.get(".document-automation-panel .error-banner")
      .scrollIntoView()
      .should("be.visible")
      .and("contain.text", "트리거 이름을 입력하세요.");

    // 5. 경계조건 검증 2: 변경 종류 3개를 모두 해제하고 등록 시도
    cy.get(".document-trigger-grid input").first().type("자동화 테스트 트리거");
    cy.get(".document-trigger-form fieldset input[type=\"checkbox\"]").each(($el) => {
      cy.wrap($el).uncheck();
    });
    cy.get(".document-trigger-form-actions button.primary").click();
    cy.get(".document-automation-panel .error-banner")
      .scrollIntoView()
      .should("be.visible")
      .and("contain.text", "감지할 변경 종류를 하나 이상 선택하세요.");

    // 6. 경계조건 검증 3: 변경 종류 복구 후 액션을 '새 채팅 요청'으로 바꾸고 프롬프트 없이 등록 시도
    cy.get(".document-trigger-form fieldset input[type=\"checkbox\"]").first().check();
    cy.get(".document-trigger-grid").last().find("select").first().select("startChat");
    cy.get(".document-trigger-form-actions button.primary").click();
    cy.get(".document-automation-panel .error-banner")
      .scrollIntoView()
      .should("be.visible")
      .and("contain.text", "새 채팅 요청 내용을 입력하세요.");

    // 스크린샷 증적 저장
    cy.screenshot("doc-trigger-form-validation");
  });
});
