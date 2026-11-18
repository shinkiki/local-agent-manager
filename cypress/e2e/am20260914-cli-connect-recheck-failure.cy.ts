/// <reference types="cypress" />
// 설정 → 연결의 CLI 카드가 여는 CLI 연결 드로워(src/components/CliConnectionDrawer.tsx)에서
// 'CLI 다시 검사'는 App의 refresh(true)를 부르고, 그 호출만 실패를 드로워 안으로 되돌려 준다
// (src/App.tsx:900, src/App.tsx:290). 지금까지의 CLI 드로워 스펙은 문구(언어)와 안내 배너만
// 봤고, 검사가 실패했을 때 사용자가 무엇을 보는지와 검사 중 버튼이 잠기는지는 보지 않았다.
//
// 여기서 붙잡는 계약은 셋이다.
//  1) 검사가 실패하면 드로워가 닫히지 않고 실패를 말하며, 버튼은 다시 눌리는 상태로 돌아온다.
//  2) 검사가 도는 동안 버튼은 잠기고 '검사 중…'으로 바뀌어, 연속 클릭이 요청을 겹쳐 쏘지 않는다.
//  3) CLI가 탐지된 공급자에서는 '채팅으로 이동'이 드로워를 닫고 채팅 화면을 연다.
//
// 격리 백엔드의 CLI 탐지는 임시 HOME이 아니라 PATH를 타므로 탐지 여부가 실행 환경마다 다르다.
// 3)은 스냅숏의 providers를 탐지됨으로 갈아 끼워 갈래를 고정한다.
const drawer = () => cy.get('[role="dialog"]');

const openCliDrawer = () => {
  cy.openSettingsTab("connections");
  cy.anchor("settings.connections").within(() => {
    cy.get(".cli-settings-provider-states button.button").first().click();
  });
  drawer().should("have.length", 1);
};

/** 스냅숏 응답의 공급자 CLI 상태를 모두 탐지됨으로 바꾼다. 전체·증분 응답 둘 다 같은 모양이다. */
const forceDetectedProviders = () => {
  const detect = (res: { body: unknown }) => {
    const body = res.body as { providers?: { cli?: Record<string, unknown> }[] };
    for (const provider of body.providers ?? []) {
      if (provider.cli) {
        provider.cli.detected = true;
        provider.cli.path = provider.cli.path ?? "/usr/local/bin/stub-cli";
      }
    }
  };
  cy.stubInvoke("get_manager_snapshot", (req) => { req.continue(detect); });
  cy.stubInvoke("get_manager_snapshot_delta", (req) => { req.continue(detect); });
};

describe("설정 · 연결 · CLI 연결 드로워의 다시 검사 실패와 채팅 이동", () => {
  it("다시 검사가 실패하면 드로워가 열린 채 실패를 말하고 버튼이 다시 열린다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    openCliDrawer();

    cy.stubInvoke("get_manager_snapshot_delta", {
      statusCode: 500,
      body: { error: "CLI 상태를 다시 읽지 못했습니다." },
    }).as("failedRecheck");

    cy.anchor("cli-connect.recheck").click();
    cy.wait("@failedRecheck");

    // 드로워는 닫히지 않는다 — 실패는 이 자리에서 읽고 바로 다시 시도할 수 있어야 한다.
    drawer().should("have.length", 1);
    drawer().within(() => {
      cy.get(".error-banner").should("exist").and("contain.text", "CLI 상태를 다시 읽지 못했습니다.");
      cy.anchor("cli-connect.recheck").should("not.be.disabled").and("have.text", "CLI 다시 검사");
    });
  });

  it("검사가 도는 동안 버튼이 잠겨 연속 클릭이 요청을 겹쳐 쏘지 않는다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    openCliDrawer();

    let recheckCount = 0;
    cy.intercept("POST", "**/api/invoke/get_manager_snapshot_delta", (req) => {
      recheckCount += 1;
      req.reply({ statusCode: 500, body: { error: "느린 검사" }, delay: 600 });
    }).as("slowRecheck");

    // 화면이 스스로 도는 주기 갱신과 섞이지 않도록, 누르기 직전 횟수를 기준으로 잰다.
    let before = 0;
    cy.then(() => { before = recheckCount; });

    cy.anchor("cli-connect.recheck").click();
    cy.anchor("cli-connect.recheck").should("be.disabled").and("have.text", "검사 중…");
    // 잠긴 버튼을 다시 눌러도 두 번째 요청이 나가지 않는다.
    cy.anchor("cli-connect.recheck").click({ force: true });

    cy.wait("@slowRecheck");
    cy.anchor("cli-connect.recheck").should("not.be.disabled");
    cy.then(() => {
      expect(recheckCount - before, "다시 검사 요청 횟수").to.equal(1);
    });
  });

  it("CLI가 탐지된 공급자에서는 '채팅으로 이동'이 드로워를 닫고 채팅 화면을 연다", () => {
    forceDetectedProviders();
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    openCliDrawer();

    drawer().within(() => {
      cy.anchor("cli-connect.status").should("have.text", "탐지 완료");
      cy.anchor("cli-connect.actions").should("exist");
      cy.anchor("cli-connect.open-chat").should("be.visible").click();
    });

    cy.get('[role="dialog"]').should("not.exist");
    cy.anchor("nav.chat").should("have.attr", "aria-current", "page");
  });
});
