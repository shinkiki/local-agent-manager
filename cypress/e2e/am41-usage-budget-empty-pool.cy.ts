// AM-41 (임시 스펙): 워크플로 → 페이싱 탭에서 계정은 있는데 페이싱 풀에는 아직 아무
// 계정도 넣지 않은 초기 상태(poolConfigured=false)를 화면이 어떻게 알리는지.
// 기존 workflows.cy.ts의 계정 풀 검증은 fixture로 참여 계정을 미리 켜 둔 상태만 다뤘고,
// AM-33은 같은 화면의 '예산 기본값' 모달 숫자 경계만 다뤘다. 풀이 비었을 때의 카드 상태
// (muted·전 계정 제외 막대·평균 지표 '–')와 요약 스트립의 0 / N은 이번이 처음이다.
// 계정 수 N은 하네스가 띄운 격리 백엔드가 정하므로 DOM에서 세어 쓴다.
function poolSection() {
  return cy.anchor("workflows.usage-budget.accounts");
}

function stat(label: string) {
  return cy.get(".workflow-overview-stats").contains("dt", label).parent().find("dd");
}

describe("페이싱 풀에 참여 계정을 하나도 고르지 않은 상태의 계정 풀 카드", () => {
  // 이 스펙은 UI 언어를 영어로 바꾼 채 끝난다. 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로
  // 스펙이 끝날 때 한국어로 되돌린다(테스트가 중간에 실패해도 도는 `after`에서).
  after(() => {
    cy.restoreLanguage();
  });

  it("풀이 비었음을 머리말·카드·막대·평균 지표가 서로 어긋나지 않게 알린다", () => {
    cy.visitApp();
    cy.openPacingTab();
    poolSection().scrollIntoView().should("be.visible");

    // 1) 계정은 있으므로 '등록된 공급자 계정이 없습니다' 빈 상태가 아니라 풀 카드가 나온다.
    poolSection().find(".settings-empty").should("not.exist");
    poolSection().find(".usage-budget-pool-card").should("exist");

    // 2) 머리말은 켜진 계정이 없다는 쪽 안내(poolConfigured=false)를 낸다.
    poolSection().find("header small")
      .should("contain.text", "켜진 계정이 없어 워크플로 인자 필터만 적용됩니다");

    // 3) 참여 계정이 0이므로 카드는 muted이고 '아직 고르지 않았다'고 말한다.
    poolSection().find(".usage-budget-pool-card").should("have.class", "muted");
    poolSection().find(".usage-budget-pool-card-head, .usage-budget-card-head").first()
      .find("small").should("have.text", "아직 참여 계정을 고르지 않았습니다.");

    // 4) 막대는 등록 계정 수만큼 나오고 전부 제외(off) 상태다.
    poolSection().find(".usage-budget-pool-bars > li").should("have.length.at.least", 1)
      .each(($bar) => {
        expect($bar.hasClass("off"), "풀에 없는 계정 막대는 off").to.equal(true);
        expect($bar.attr("title")).to.contain("제외됨");
      });

    // 5) 카드 제목의 "페이싱 계정 0 / N"과 요약 스트립의 0 / N이 막대 수와 일치한다.
    poolSection().find(".usage-budget-pool-bars > li").its("length").then((count) => {
      poolSection().find(".usage-budget-pool-card strong").first()
        .should("have.text", `페이싱 계정 0 / ${count}`);
      stat("페이싱 계정").should("have.text", `0 / ${count}`);
    });

    // 6) 참여 계정이 없으니 평균 지표와 최다 소진 계정은 값 대신 '–'를 낸다.
    poolSection().find(".usage-budget-metrics").within(() => {
      cy.contains("dt", "평균 소진율").parent().find("dd").should("contain.text", "–");
      cy.contains("dt", "평균 순여유").parent().find("dd").should("contain.text", "–");
      cy.contains("dt", "최다 소진 계정").parent().find("dd").should("contain.text", "–");
    });

    // 7) 풀이 비어 있으면 '비활성/사용량 없음' 보조 문구는 셈할 대상이 없어 나오지 않는다.
    poolSection().find(".usage-budget-card-note").should("not.exist");

    // 8) 그래도 풀을 채우러 갈 수단('계정 풀 설정')은 열려 있어야 한다.
    poolSection().find('[aria-label="계정 풀 설정"]').should("not.be.disabled");
  });

  it("풀이 빈 상태는 화면을 다녀와도 그대로고, 새로고침 뒤 탭 선택만 기본으로 돌아간다", () => {
    cy.visitApp();
    cy.openPacingTab();
    poolSection().find(".usage-budget-pool-card").should("have.class", "muted");

    // 9) 다른 화면을 다녀와도 페이싱 탭 선택과 카드 상태가 남는다.
    cy.revisitView("workflows");
    cy.anchor("workflows.tab.recurring").should("have.attr", "aria-selected", "true");
    poolSection().find(".usage-budget-pool-card").should("have.class", "muted");

    // 10) 새로고침하면 탭 선택은 저장하지 않는 값이라 기본 탭으로 돌아간다.
    cy.reload();
    cy.anchor("nav.workflows").click();
    cy.anchor("workflows.tab.catalog").should("have.attr", "aria-selected", "true");

    // 11) 다시 열어도 같은 상태이고 오류 배너는 없다.
    cy.anchor("workflows.tab.recurring").click();
    poolSection().find(".usage-budget-pool-card").should("have.class", "muted");
    cy.anchor("workflows.usage-budget").find(".error-banner").should("not.exist");
  });

  it("영어로 바꾸면 빈 풀을 설명하는 머리말과 카드 문구도 함께 번역된다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.anchor("nav.workflows").should("contain.text", "Workflows").click();
    cy.anchor("workflows.tab.recurring").click();
    poolSection().scrollIntoView();

    // 12) 빈 풀을 설명하는 두 문구가 영어로 바뀐다.
    poolSection().find("header small").should("contain.text", "No account is enabled");
    poolSection().find(".usage-budget-card-head").first().find("small")
      .should("have.text", "No account has been added to the pool yet.");

    // 13) 막대 title도 영어여야 한다 — 한국어 '제외됨'이 남으면 안 된다.
    poolSection().find(".usage-budget-pool-bars > li").first()
      .should("have.attr", "title").and("contain", "excluded");
  });
});
