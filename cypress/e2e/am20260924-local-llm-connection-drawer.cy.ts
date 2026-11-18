/// <reference types="cypress" />
// 로컬 공급자의 연결 관리는 다른 공급자와 다른 것을 묻는다. 설치할 CLI가 자기 것이 없고,
// 필요한 것은 실행 하네스와 서빙 서버 둘이다. 그래서 드로워가 CLI 설치·로그인·검증
// 네 단계 대신 하네스·서빙 서버·주소 등록 세 단계를 세우고, 연결 카드를 그 자리에서 연다.
//
// 이 스펙이 붙잡는 계약은 셋이다. 로컬 카드를 눌렀을 때 (1) 연결 설정을 그 자리에서 할 수
// 있고 — 설정 탭을 가리키는 막다른 길이 아니고, (2) 무엇을 설치해야 하는지 명령이 보이고,
// (3) 계정 로그인 단계가 없다. 하네스를 갈아끼울 때 이 셋이 먼저 깨진다.
describe("설정 · 연결 · 로컬 LLM 연결 드로워", () => {
  const openLocalDrawer = () => {
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").within(() => {
      // 공급자 카드는 claude·codex·antigravity·local 순으로 선다. 로컬은 표시명으로 잡는다 —
      // 순서로 잡으면 공급자가 하나 늘 때 엉뚱한 카드를 연다.
      cy.contains(".cli-settings-provider", "Ollama")
        .find(".cli-settings-provider-states button.button")
        .click();
    });
  };

  it("연결 설정을 드로워 안에서 바로 할 수 있다", () => {
    openLocalDrawer();
    // 카드가 드로워 안에 있어야 한다. 예전에는 "설정에서 등록하세요"라는 안내만 있었고,
    // 연결 관리를 눌렀는데 연결을 설정할 수 없는 막다른 길이었다.
    cy.anchor("settings.local-llm").should("be.visible");
    cy.get("#local-llm-base-url").should("exist");
  });

  it("무엇을 설치해야 하는지 하네스와 서빙 서버를 나눠 보여 준다", () => {
    openLocalDrawer();
    cy.anchor("cli-connect.steps").within(() => {
      // 로컬 모델은 둘이 있어야 돈다. 하나만 보여 주면 나머지에서 막힌다.
      cy.contains("npm install -g opencode-ai").should("be.visible");
      cy.contains("ollama pull").should("be.visible");
      // OpenAI 호환이면 Ollama가 아니어도 된다는 것이 읽혀야 한다.
      cy.contains("OpenAI 호환").should("be.visible");
    });
  });

  it("계정 로그인 단계를 두지 않는다", () => {
    openLocalDrawer();
    // 하네스에 로그인할 일이 없고 모델은 서빙 서버가 맡는다. 다른 공급자 드로워에서
    // 그대로 베껴 오면 이 단계가 따라 들어온다. 단계 제목만 본다 — 본문에는
    // "계정 로그인은 필요 없습니다"라고 적혀 있고, 그건 남아 있어야 하는 문장이다.
    cy.anchor("cli-connect.steps").find("> li").should("have.length", 3);
    cy.anchor("cli-connect.steps")
      .find("> li > div > strong")
      .each(($title) => {
        expect($title.text().trim()).to.not.equal("계정 로그인");
      });
    // 로그인이 왜 없는지는 화면에서 읽혀야 한다. 없애기만 하면 사용자는 빠뜨린 줄 안다.
    cy.anchor("cli-connect.steps").should("contain.text", "계정 로그인은 필요 없습니다");
  });
});
