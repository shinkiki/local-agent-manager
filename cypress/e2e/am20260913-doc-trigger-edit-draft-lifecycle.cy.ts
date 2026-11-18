/// <reference types="cypress" />
import { cleanupDocRoot } from "../support/docRootFixtures";
// 문서 화면 "변경 자동화" 섹션의 트리거 초안 수명 — 등록 → 수정 진입 → 다른 트리거로 갈아타기 →
// 취소로 돌아오기.
// 기존 스펙이 다룬 범위:
//  - am20260906-docs-automation-empty: 감시 폴더가 없을 때의 빈 상태
//  - am20260908-doc-trigger-form-validation: 등록 폼 기본값과 필수값 검증
//  - am20260912-doc-trigger-status-toggle: 등록된 행의 상태 표기와 활성 스위치
// 어느 쪽도 "폼이 등록 모드와 수정 모드를 오갈 때 초안이 어떻게 갈리는지"는 보지 않았다.
// 02f8710d(트리거 초안 상태와 저장 검증을 useDocumentTriggerDraft로 분리)가 바로 그 수명주기를
// 옮겼고, 수정 진입은 빈 초안이 아니라 현재 초안 위에 트리거 값을 덮는 병합이다
// (src/components/DocumentAutomationPanel.tsx:105 draftFromTrigger, :298 reset, :302 edit).
// 그래서 화면에서 확인한다:
//  - 등록 직후 폼이 등록 모드 기본값으로 비워지고(이름·프롬프트 공백, 액션은 '예약 실행'), 취소 버튼이 없다
//  - 저장하지 않은 새 초안을 채워 둔 채 기존 트리거 '수정'을 누르면 그 트리거 값으로 완전히 갈린다
//  - 수정 모드에서 다른 트리거의 '수정'을 눌러도 앞 트리거 값이 남지 않는다
//  - '취소'는 목록을 바꾸지 않고 폼만 등록 모드 빈 초안으로 되돌린다

describe("문서 변경 자동화 · 트리거 초안의 등록·수정·취소 수명", () => {
  const targetDir = `/tmp/am-e2e-doctrigger-draft-${Date.now()}`;
  const nameA = "초안수명 트리거 A";
  const nameB = "초안수명 트리거 B";
  const promptA = "A 트리거의 저장된 프롬프트";
  const promptB = "B 트리거의 저장된 프롬프트";

  const tabs = () => cy.view("docs").find(".docs-section-tabs button");
  const form = () => cy.get(".document-trigger-form");
  const scopeGrid = () => form().find(".document-trigger-grid").first();
  const nameInput = () => scopeGrid().find("input").first();
  const includeInput = () => scopeGrid().find("textarea").first();
  const actionSelect = () => form().find(".document-trigger-grid").last().find("select").first();
  const promptInput = () => form().find("textarea").last();
  const primaryButton = () => cy.get(".document-trigger-form-actions button.primary");
  const cancelButton = () => cy.get(".document-trigger-form-actions").contains("button", "취소");
  const rowByName = (name: string) => cy.get(".document-trigger-list article").contains("strong", name).closest("article");

  // 새 채팅 트리거 하나를 폼으로 등록한다. 저장 후 폼은 등록 모드 빈 초안으로 돌아온다.
  function createChatTrigger(name: string, prompt: string) {
    nameInput().type(name);
    actionSelect().select("startChat");
    promptInput().type(prompt);
    primaryButton().click();
    cy.get(".document-automation-panel .error-banner").should("not.exist");
  }

  before(() => {
    cy.exec(`mkdir -p ${targetDir}`);
  });

  after(() => {
    // 격리 백엔드는 스펙 사이에 상태가 새므로(메모리: e2e-suite-state-leakage) 만든 것은 되돌린다.
    cy.request("POST", "/api/invoke/get_document_automation_snapshot", {}).then((res) => {
      const triggers = (res.body?.triggers ?? []) as Array<{ id: string; name: string }>;
      for (const trigger of triggers) {
        if (trigger.name === nameA || trigger.name === nameB) {
          cy.request("POST", "/api/invoke/delete_document_trigger", { id: trigger.id });
        }
      }
    });
    cleanupDocRoot(targetDir);
  });

  it("수정 진입은 폼을 그 트리거 값으로 갈아끼우고, 취소는 목록을 건드리지 않고 빈 초안으로 되돌린다", () => {
    cy.visitApp();
    cy.openView("docs").should("be.visible");

    // 0. 감시 대상 등록 폴더를 하나 세운다(트리거 등록의 사전조건).
    cy.get('[aria-label="등록 폴더 추가"]').first().click({ force: true });
    cy.get(".root-form input").eq(1).type(targetDir);
    cy.contains(".root-form button", "폴더 등록").click();
    cy.get(".root-form").should("not.exist");
    cy.get(".root-row").should("have.length", 1);

    tabs().eq(1).click();
    form().find("header strong").should("have.text", "파일 트리거 등록");
    cy.get(".document-trigger-list .tree-empty").should("contain.text", "등록된 트리거가 없습니다.");

    // 1. 트리거 두 개를 등록한다. 두 번째 등록이 첫 번째 저장 뒤의 초안 비우기까지 함께 증명한다.
    createChatTrigger(nameA, promptA);

    // 저장 직후 폼은 '등록' 모드 빈 초안이다 — 방금 친 이름·프롬프트가 남아 있으면 안 되고,
    // 액션도 기본값(예약 실행)으로 돌아오며 수정 모드에만 있는 취소 버튼이 없다.
    form().find("header strong").should("have.text", "파일 트리거 등록");
    primaryButton().should("contain.text", "트리거 등록");
    cy.get(".document-trigger-form-actions button").should("have.length", 1);
    nameInput().should("have.value", "");
    actionSelect().should("have.value", "runSchedule");
    includeInput().should("have.value", "**/*");

    createChatTrigger(nameB, promptB);
    cy.get(".document-trigger-list header span").should("have.text", "2개");

    // 2. 저장하지 않은 새 초안을 채워 둔 채 A의 '수정'을 누른다. 화면은 A의 값으로 완전히 갈려야 한다.
    nameInput().type("저장하지 않은 초안");
    actionSelect().select("startChat");
    promptInput().type("저장하지 않은 프롬프트");
    includeInput().clear().type("draft/**");

    rowByName(nameA).contains("button", "수정").click();
    form().find("header strong").should("have.text", "파일 트리거 수정");
    primaryButton().should("contain.text", "수정 저장");
    nameInput().should("have.value", nameA);
    promptInput().should("have.value", promptA);
    includeInput().should("have.value", "**/*");

    // 3. 수정 모드에서 값을 고친 뒤 저장하지 않고 곧바로 B의 '수정'으로 갈아탄다.
    //    앞 트리거에서 친 값이 한 칸이라도 남으면 사용자는 B를 A의 내용으로 덮어쓰게 된다.
    nameInput().clear().type("A를 고치다 만 이름");
    promptInput().clear().type("A를 고치다 만 프롬프트");

    rowByName(nameB).contains("button", "수정").click();
    form().find("header strong").should("have.text", "파일 트리거 수정");
    nameInput().should("have.value", nameB);
    promptInput().should("have.value", promptB);

    // 4. 취소는 폼만 등록 모드 빈 초안으로 되돌린다. 목록의 두 트리거는 이름까지 그대로다.
    cancelButton().click();
    form().find("header strong").should("have.text", "파일 트리거 등록");
    primaryButton().should("contain.text", "트리거 등록");
    cy.get(".document-trigger-form-actions button").should("have.length", 1);
    nameInput().should("have.value", "");
    actionSelect().should("have.value", "runSchedule");
    includeInput().should("have.value", "**/*");

    cy.get(".document-trigger-list header span").should("have.text", "2개");
    rowByName(nameA).should("exist");
    rowByName(nameB).should("exist");
    cy.get(".document-trigger-list article").contains("strong", "A를 고치다 만 이름").should("not.exist");
  });
});
