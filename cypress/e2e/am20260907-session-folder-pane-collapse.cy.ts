/// <reference types="cypress" />
// 세션 폴더 패널(aside.session-folders)을 접었다 펴는 계약을 검증한다.
// 기존 세션 폴더 스펙은 생성(AM-31), 편집기의 이름·색상·숨김(am20260906-session-folder-edit),
// 삭제 확인(am20260907-session-folder-delete), 형제 순서 이동(am20260907-session-folder-reorder)까지만
// 다뤘고, 패널을 접었을 때 나타나는 복원 버튼(secondary-pane-restore)의 현재 폴더 라벨,
// 접기·펴기에 따른 포커스 이동, 레이아웃 클래스(folders-closed), 그리고 접힘 상태가
// localStorage에 저장되어 새로고침 뒤에도 잔존하는지는 한 번도 검증한 적이 없다.
// 관련 코드:
//   src/components/SessionsView.tsx:308 (readSecondaryPaneOpen 초기값)
//   src/components/SessionsView.tsx:318-330 (setFolderPaneVisibility / 저장 / 포커스 이동)
//   src/components/SessionsView.tsx:380 (collapsedFolderLabel)
//   src/components/SessionsView.tsx:506,524 (folders-closed 클래스, 복원 버튼)
//   src/components/SessionsView.tsx:1058 (세션 폴더 숨기기 버튼)
//   src/lib/secondaryPane.ts:7,19 (localStorage 읽기·쓰기)

function hideButton() {
  return cy.get('.session-folders button[aria-label="세션 폴더 숨기기"]');
}

function restoreButton() {
  return cy.get('.session-list-pane button.secondary-pane-restore');
}

function collapse(): void {
  hideButton().click();
  cy.get("aside.session-folders").should("not.exist");
}

describe("세션 폴더 패널 접기·펴기의 라벨·포커스·레이아웃과 새로고침 잔존", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("sessions");
    // 이전 it이 남긴 접힘 상태를 지우고 항상 펼친 상태에서 시작한다.
    cy.get("body").then(($body) => {
      if ($body.find("aside.session-folders").length === 0) {
        restoreButton().click();
      }
    });
    cy.get("aside.session-folders").should("be.visible");
  });

  it("접으면 패널이 사라지고 복원 버튼이 접힌 상태로 노출되며 포커스가 복원 버튼으로 옮겨간다", () => {
    cy.get(".sessions-layout").should("not.have.class", "folders-closed");
    restoreButton().should("not.exist");

    collapse();

    cy.get(".sessions-layout").should("have.class", "folders-closed");
    restoreButton()
      .should("be.visible")
      .and("have.attr", "aria-expanded", "false")
      .and("have.attr", "data-ui-anchor", "sessions.folders");
    // 접기 버튼이 사라지므로 포커스는 복원 버튼이 넘겨받아야 한다.
    restoreButton().should("have.focus");

    restoreButton().click();
    cy.get("aside.session-folders").should("be.visible");
    cy.get(".sessions-layout").should("not.have.class", "folders-closed");
    // 펼치면 포커스는 다시 숨기기 버튼으로 돌아온다.
    hideButton().should("have.focus");
  });

  it("복원 버튼은 접기 직전에 고른 폴더 필터를 라벨과 접근성 이름에 적는다", () => {
    // 기본값(전체 세션)에서 접으면 라벨은 '폴더'다.
    collapse();
    restoreButton().should("contain.text", "폴더");
    restoreButton().should("have.attr", "aria-label", "세션 폴더 보기 · 현재 폴더");
    restoreButton().should("have.attr", "title", "세션 폴더 보기 · 현재 폴더");
    restoreButton().click();

    // '미분류'를 고르고 접으면 라벨과 접근성 이름이 미분류를 가리킨다.
    cy.get(".folder-list button.folder-filter").contains("미분류").click();
    cy.get(".folder-list button.folder-filter.active").should("contain.text", "미분류");
    collapse();
    restoreButton().should("contain.text", "미분류");
    restoreButton().should("have.attr", "aria-label", "세션 폴더 보기 · 현재 미분류");
    restoreButton().should("have.attr", "title", "세션 폴더 보기 · 현재 미분류");
  });

  it("접힘 상태는 새로고침 뒤에도 유지되고, 펼침으로 되돌리면 그 상태도 유지된다", () => {
    collapse();

    cy.visitApp();
    cy.openView("sessions");
    cy.get("aside.session-folders").should("not.exist");
    restoreButton().should("be.visible");
    cy.get(".sessions-layout").should("have.class", "folders-closed");

    // 다시 펼친 뒤 새로고침하면 펼친 상태가 남아야 한다.
    restoreButton().click();
    cy.get("aside.session-folders").should("be.visible");

    cy.visitApp();
    cy.openView("sessions");
    cy.get("aside.session-folders").should("be.visible");
    restoreButton().should("not.exist");
  });
});
