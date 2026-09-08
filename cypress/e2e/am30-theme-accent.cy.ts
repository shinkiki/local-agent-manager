// AM-30 (임시 스펙): 설정 → 화면·채팅의 테마 모드·메인 색상 선택이 문서 루트
// (data-theme / data-accent)에 실제로 적용되는지, 기본값은 속성을 지우는 방식인지,
// localStorage에 저장돼 새로고침을 건너 복원되는지, 알 수 없는 저장값이 기본으로
// 떨어지는지, 그리고 영어 전환 때 옵션 제목이 함께 번역되는지.
// 기존 AM-2·AM-12·AM-17은 언어 전환만, AM-15는 같은 탭의 '메시지 표시 방식'만 다뤘고
// 테마·악센트는 이번이 처음이다.
const THEME_KEY = "agent-manager.theme-mode.v1";
const ACCENT_KEY = "agent-manager.accent-color.v1";

function visitWithStored(seed: Record<string, string>): void {
  cy.visitApp(seed);
  openDisplayTab();
}

function openDisplayTab(): void {
  cy.openSettingsTab("display");
}

function themeGroup() {
  return cy.get('[role="radiogroup"][aria-label="화면 테마"]');
}

function accentGroup() {
  return cy.get('[role="radiogroup"][aria-label="메인 색상"]');
}

describe("테마 모드·메인 색상의 문서 루트 적용과 저장·복원 경계", () => {
  // 이 스펙은 UI 언어를 영어로 바꾼 채 끝난다. 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로
  // 스펙이 끝날 때 한국어로 되돌린다(테스트가 중간에 실패해도 도는 `after`에서).
  after(() => {
    cy.restoreLanguage();
  });

  it("기본값은 루트 속성을 비워 두고, 고른 값은 루트와 저장소에 함께 반영된다", () => {
    visitWithStored({});

    // 1) 저장값이 없으면 테마는 '자동', 악센트는 '황동'이고 루트 속성이 없다.
    themeGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "자동 (시스템 연동)");
    accentGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "황동");
    cy.document().its("documentElement.dataset.theme").should("be.undefined");
    cy.document().its("documentElement.dataset.accent").should("be.undefined");

    // 2) 다크 모드를 고르면 루트에 data-theme="dark"가 붙고 저장값이 남는다.
    themeGroup().find('[role="radio"]').contains("다크 모드").click();
    themeGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "다크 모드");
    cy.document().its("documentElement.dataset.theme").should("equal", "dark");
    cy.window().then((win) => expect(win.localStorage.getItem(THEME_KEY)).to.equal("dark"));

    // 3) 악센트를 그린으로 바꾸면 루트에 data-accent="green"이 붙는다.
    accentGroup().find('[role="radio"]').contains("그린").click();
    accentGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "그린");
    cy.document().its("documentElement.dataset.accent").should("equal", "green");
    cy.window().then((win) => expect(win.localStorage.getItem(ACCENT_KEY)).to.equal("green"));

    // 4) 기본값으로 되돌리면 속성을 남기지 않고 지운다(비어 있음이 기본값의 표현이다).
    themeGroup().find('[role="radio"]').contains("자동 (시스템 연동)").click();
    cy.document().its("documentElement.dataset.theme").should("be.undefined");
    accentGroup().find('[role="radio"]').contains("황동").click();
    cy.document().its("documentElement.dataset.accent").should("be.undefined");
    cy.window().then((win) => {
      expect(win.localStorage.getItem(THEME_KEY)).to.equal("auto");
      expect(win.localStorage.getItem(ACCENT_KEY)).to.equal("brass");
    });
  });

  it("저장한 조합은 새로고침을 건너 복원되고 화면 전환 뒤에도 남는다", () => {
    visitWithStored({ [THEME_KEY]: "light", [ACCENT_KEY]: "violet" });

    // 5) 저장값이 첫 화면부터 루트에 적용된 채로 열린다.
    cy.document().its("documentElement.dataset.theme").should("equal", "light");
    cy.document().its("documentElement.dataset.accent").should("equal", "violet");
    themeGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "라이트 모드");
    accentGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "바이올렛");

    // 6) 다른 화면을 다녀와도 루트 속성과 선택이 유지된다.
    cy.anchor("nav.dashboard").click();
    cy.view("settings").should("not.exist");
    cy.document().its("documentElement.dataset.theme").should("equal", "light");
    openDisplayTab();
    themeGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "라이트 모드");

    // 7) 새로고침 뒤에도 같은 조합으로 복원된다.
    cy.reload();
    cy.document().its("documentElement.dataset.theme").should("equal", "light");
    cy.document().its("documentElement.dataset.accent").should("equal", "violet");
  });

  it("알 수 없는 저장값은 조용히 쓰이지 않고 기본값으로 떨어진다", () => {
    visitWithStored({ [THEME_KEY]: "무엇인가", [ACCENT_KEY]: "무슨색" });

    // 8) 목록에 없는 값은 무시하고 자동·황동으로 시작하며 루트 속성도 남기지 않는다.
    themeGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "자동 (시스템 연동)");
    accentGroup().find('[role="radio"][aria-checked="true"]').should("contain.text", "황동");
    cy.document().its("documentElement.dataset.theme").should("be.undefined");
    cy.document().its("documentElement.dataset.accent").should("be.undefined");

    // 9) 화면에서 한 번 고르면 정규화된 값이 저장으로 되써진다.
    themeGroup().find('[role="radio"]').contains("다크 모드").click();
    cy.window().then((win) => expect(win.localStorage.getItem(THEME_KEY)).to.equal("dark"));
  });

  it("영어로 바꾸면 테마·메인 색상 옵션의 제목과 설명도 함께 번역된다", () => {
    visitWithStored({});

    // 10) 언어를 영어로 바꾼다.
    cy.anchor("settings.tab.language").click();
    cy.languageSelect().select("en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions");

    // 11) 화면 전체가 영어인데 테마·악센트 옵션만 한국어로 남으면 안 된다.
    cy.anchor("settings.tab.display").click();
    cy.get('[role="radiogroup"][aria-label="Display theme"]')
      .invoke("text")
      .should("not.match", /[가-힣]/);
    cy.get('[role="radiogroup"][aria-label="Accent color"]')
      .invoke("text")
      .should("not.match", /[가-힣]/);
  });
});
