/// <reference types="cypress" />
// 영어 UI에서 설정 → 표시 탭의 네 라디오그룹(테마·강조색·메시지 표시 방식·Enter 키 동작)이 영어로 도달하는지와,
// 영어 상태에서 고른 메시지 표시 방식이 저장값·새로고침을 건너 남는지 본다. AM-15는 같은 항목을
// 한국어 UI의 저장 계약으로만 봤고, AM-30은 강조색만 봤다.
// 2026-10-05: caa36130 이 표시 탭에 Enter 키 동작 그룹을 더해 셋이 넷이 됐다. 이 스펙은 그때부터 선행 실패였고,
// 네 번째 그룹은 결함이 아니라 의도된 설정이라 기대값을 넷으로 올리고 그 그룹의 영어 계약도 같이 잡는다.
const MODE_KEY = "agent-manager.message-display-mode.v2";
const ENTER_KEY = "agent-manager.composer-enter-mode";

function openDisplay() {
  cy.openSettingsTab("display");
  cy.get('[role="radiogroup"]').should("have.length", 4);
}

function enterGroup() {
  return cy.get('[role="radiogroup"][aria-label="Enter key"]');
}

function chatGroup() {
  return cy.get('[role="radiogroup"][aria-label="Chat message display"]');
}

describe("영어 UI 표시 탭 현지화와 메시지 표시 방식 잔존", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.setLanguage("en");
  });

  // 이 스펙은 영어로 바꾼 채 끝나므로 반드시 한국어로 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  it("네 라디오그룹의 접근성 이름이 영어 계약값과 같다", () => {
    openDisplay();
    cy.get('[role="radiogroup"]').eq(0).should("have.attr", "aria-label", "Display theme");
    cy.get('[role="radiogroup"]').eq(1).should("have.attr", "aria-label", "Accent color");
    cy.get('[role="radiogroup"]').eq(2).should("have.attr", "aria-label", "Chat message display");
    cy.get('[role="radiogroup"]').eq(3).should("have.attr", "aria-label", "Enter key");
  });

  it("메시지 표시 방식 세 선택지의 제목·설명에 한글이 남지 않는다", () => {
    openDisplay();
    chatGroup().find('[role="radio"]').should("have.length", 3);
    chatGroup().invoke("text").should("not.match", /[가-힣]/);
    chatGroup().find('[role="radio"]').eq(0).should("contain.text", "Start at your last message");
    chatGroup().find('[role="radio"]').eq(1).should("contain.text", "Show conversation start");
    chatGroup().find('[role="radio"]').eq(2).should("contain.text", "Show latest messages");
  });

  it("Enter 키 동작 세 선택지의 제목·설명에 한글이 남지 않고 고른 값이 저장값에 남는다", () => {
    openDisplay();
    enterGroup().find('[role="radio"]').should("have.length", 3);
    enterGroup().invoke("text").should("not.match", /[가-힣]/);
    enterGroup().find('[role="radio"]').eq(0).should("contain.text", "Auto");
    enterGroup().find('[role="radio"]').eq(1).should("contain.text", "Enter sends");
    enterGroup().find('[role="radio"]').eq(2).should("contain.text", "Enter inserts a line break");
    enterGroup().find('[role="radio"]').eq(2).click().should("have.attr", "aria-checked", "true");
    cy.window().its("localStorage").invoke("getItem", ENTER_KEY).should("eq", "newline");
    // 다음 스펙에 값을 흘리지 않도록 기본값으로 되돌린다.
    enterGroup().find('[role="radio"]').eq(0).click().should("have.attr", "aria-checked", "true");
  });

  it("선택 상태 꼬리표가 Selected 하나, 나머지는 Select로 나온다", () => {
    openDisplay();
    chatGroup().find('[role="radio"][aria-checked="true"]').should("have.length", 1)
      .find("em").should("have.text", "Selected");
    chatGroup().find('[role="radio"][aria-checked="false"]').should("have.length", 2)
      .each(($radio) => {
        expect($radio.find("em").text()).to.eq("Select");
      });
  });

  it("영어 화면에서 고른 값이 저장값에 남고 새로고침 뒤에도 그 선택지가 켜져 있다", () => {
    openDisplay();
    chatGroup().find('[role="radio"]').eq(1).click().should("have.attr", "aria-checked", "true");
    chatGroup().find('[role="radio"][aria-checked="true"]').should("have.length", 1);
    cy.window().its("localStorage").invoke("getItem", MODE_KEY).should("eq", "start");

    // 새로고침해도 저장값에서 복원된다. 언어도 영어 그대로다.
    cy.visitApp();
    openDisplay();
    chatGroup().find('[role="radio"]').eq(1)
      .should("have.attr", "aria-checked", "true")
      .and("contain.text", "Show conversation start");

    // 다음 스펙에 값을 흘리지 않도록 기본값으로 되돌린다.
    chatGroup().find('[role="radio"]').eq(0).click().should("have.attr", "aria-checked", "true");
  });
});
