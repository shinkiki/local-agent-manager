// AM-27 (임시 스펙): 등록 계정 0건이지만 호스트 PATH의 CLI는 탐지되는 격리 하네스에서,
// 연결 탭의 계정 0건 안내가 가리킨 '새 계정 로그인' 수단이 실제로 눌리는 상태인지와
// 그 안내가 영어 전환을 따라가는지.
describe("계정 0건 연결 탭의 빈 상태 안내와 계정 추가 수단", () => {
  const openConnections = () => {
    cy.anchor("nav.settings").click();
    cy.anchor("settings.tab.connections").click();
    cy.anchor("settings.connections").should("be.visible");
  };

  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    openConnections();
  });

  // 이 스펙은 UI 언어를 영어로 바꾼 채 끝난다. 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로
  // 스펙이 끝날 때 한국어로 되돌린다(테스트가 중간에 실패해도 도는 `after`에서).
  after(() => {
    cy.restoreLanguage();
  });

  it("계정 0건 안내와 그 안내가 가리킨 계정 추가 버튼이 함께 있다", () => {
    // 관리 대상 공급자(claude·codex) 카드가 각각 계정 0건 안내를 낸다.
    cy.get(".provider-account-empty").should("have.length", 2);
    cy.get(".provider-account-empty").first()
      .should("contain.text", "등록된 계정이 없습니다. 새 계정 로그인을 시작하세요.");

    // 안내가 지시한 수단이 눌릴 수 있는 상태로 같은 카드 안에 있다.
    cy.get(".provider-account-add-actions button").should("have.length", 2);
    cy.get(".provider-account-add-actions button").first()
      .should("contain.text", "계정 추가")
      .and("not.be.disabled");
  });

  it("CLI가 탐지된 카드는 경로와 탐지 상태를 함께 알린다", () => {
    cy.get(".cli-settings-provider-states em.health.ready").should("contain.text", "CLI 탐지됨");
    cy.get(".cli-settings-provider-copy small").first().invoke("text").should("match", /^\//);
    cy.get(".cli-settings-provider-states button").first().should("contain.text", "연결 관리");
  });

  it("영어로 바꾸면 계정 0건 안내에서 한글이 사라진다", () => {
    cy.anchor("settings.tab.language").click();
    cy.get(".language-settings-body", { timeout: 20000 }).should("exist");
    cy.get(".language-settings-body select").first().select("en");
    cy.anchor("nav.sessions").should("contain.text", "Sessions");
    cy.anchor("settings.tab.connections").click();
    cy.get(".provider-account-empty").first().invoke("text").should("not.match", /[가-힣]/);
  });

  it("연결 탭 선택이 화면 전환 뒤에도 남는다", () => {
    cy.revisitView("settings");
    cy.anchor("settings.tab.connections").should("have.attr", "aria-selected", "true");
    cy.anchor("settings.connections").should("be.visible");
  });
});
