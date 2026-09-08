// 워크플로 → 페이싱 탭의 '페이싱 회차'(소비자) 카드가 소비자를 하나도 등록하지 않은
// 초기 상태(selectionConfigured=false)를 어떻게 알리는지 본다.
// AM-41은 같은 화면의 '계정 풀' 카드만, AM-33은 '예산 기본값' 모달 숫자 경계만 다뤘고,
// 소비자 카드의 빈 상태와 그 도움말 팝오버의 분기 문구는 이번이 처음이다.
function consumers() {
  return cy.anchor("workflows.usage-budget.consumers");
}

function stat(label: string) {
  return cy.get(".workflow-overview-stats").contains("dt", label).parent().find("dd");
}

describe("페이싱 회차 소비자를 하나도 등록하지 않은 상태의 페이싱 회차 카드", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("소비자가 없음을 머리말·빈 안내·요약 지표가 서로 어긋나지 않게 알린다", () => {
    cy.visitApp();
    cy.openPacingTab();
    consumers().scrollIntoView().should("be.visible");

    // 1) 머리말은 '아직 등록된 소비자가 없다'는 쪽(selectionConfigured=false) 안내를 낸다.
    consumers().find("header small")
      .should("have.text", "아직 등록된 소비자가 없어 모든 반복 요청이 허용됩니다.");

    // 2) 소비자 카드는 하나도 없고 빈 안내 문단만 나온다.
    consumers().find(".usage-budget-consumer-card").should("not.exist");
    consumers().find(".settings-empty").should("have.length", 1);

    // 3) 요약 스트립의 참여 반복 요청·지금 도는 회차는 0이고, 분모도 0이다.
    stat("참여 반복 요청").should("have.text", "0 / 0");
    stat("지금 도는 회차").should("contain.text", "0");

    // 4) 빈 안내 문구는 페이싱 워크플로 수에 따라 갈리며, 어느 쪽이든 요약 스트립의
    //    '페이싱 워크플로' 수와 짝이 맞아야 한다.
    stat("페이싱 워크플로").invoke("text").then((raw) => {
      const paced = Number.parseInt(raw.trim(), 10);
      consumers().find(".settings-empty").should(
        "contain.text",
        paced === 0
          ? "페이싱 대상 워크플로가 없습니다"
          : "페이싱을 켠 워크플로를 돌리는 반복 요청이 없습니다",
      );
    });

    // 5) 회차 운영 안내 도구모음은 소비자가 없어도 남는다.
    consumers().find(".usage-budget-trigger-toolbar").should("exist");
  });

  it("도움말 팝오버는 소비자가 없는 쪽 문구를 내고, 화면을 다녀와도 빈 상태가 그대로다", () => {
    cy.visitApp();
    cy.openPacingTab();

    // 6) 물음표 도움말은 '하나라도 켜면 선택이 시작된다'는 미설정 분기 문구를 낸다.
    consumers().find('[aria-label="페이싱 회차 기동 및 우선순위 안내"]').click();
    cy.get(".help-hint-popover").should("be.visible")
      .and("contain.text", "아직 등록된 소비자가 없어")
      .and("contain.text", "하나라도 켜면 선택이 시작됩니다");
    // 7) 미설정 분기이므로 우선순위 배분 설명은 나오지 않는다.
    cy.get(".help-hint-popover").should("not.contain.text", "0이 가장 높음");
    cy.get("body").type("{esc}");
    cy.get(".help-hint-popover").should("not.exist");

    // 8) 다른 화면을 다녀와도 페이싱 탭 선택과 빈 상태가 남는다.
    cy.revisitView("workflows");
    cy.anchor("workflows.tab.recurring").should("have.attr", "aria-selected", "true");
    consumers().find(".settings-empty").should("have.length", 1);
  });

  it("영어로 바꿔도 같은 빈 상태를 영어 문구로 낸다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.openPacingTab();
    consumers().find("header small")
      .should("have.text", "No consumer is registered yet; all schedules are allowed.");
    consumers().find(".usage-budget-consumer-card").should("not.exist");
    consumers().find(".settings-empty").should("have.length", 1);
  });
});
