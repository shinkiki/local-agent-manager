import {
  pacingAccount,
  pacingAccountOverview,
  pacingConsumer,
  stubWorkflowCatalog,
  usageBudget,
  workflowDetail,
  workflowSummary,
} from "../support/workflowFixtures";

describe("워크플로 화면", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("workflows");
  });

  it("워크플로 관리 탭이 먼저 열린다", () => {
    cy.anchor("workflows.tab.catalog").should("have.class", "active").and("contain.text", "워크플로 관리");
    cy.get(".workflow-workspace").should("be.visible");
  });

  it("워크플로 페이싱 탭에 요약과 사용량 예산 카드가 있다", () => {
    cy.anchor("workflows.tab.recurring").should("contain.text", "워크플로 페이싱").click();
    // 요약 패널이 먼저 오고 그 아래에 설정 카드가 온다.
    cy.get(".recurring-overview .workflow-overview-stats").should("be.visible");
    // 요약 카드의 스케줄 버튼이 페이싱 스케줄 모달(제한 시간대 한 줄 + 요일 7개)을 연다.
    cy.anchor("workflows.usage-budget.schedule").should("contain.text", "스케줄").should("not.be.disabled").click();
    cy.get(".modal .modal-title").should("contain.text", "페이싱 스케줄");
    cy.get(".modal .time-range input[type=time]").should("have.length", 2);
    cy.get(".modal .weekday-picker input[type=checkbox]").should("have.length", 7);
    cy.get("body").type("{esc}");
    cy.get(".modal").should("not.exist");
    cy.anchor("workflows.usage-budget").should("be.visible");
    // 설명 문단은 한글을 어절 단위로 끊어야 한다. 기본 줄바꿈은 "버튼에 / 서"처럼 낱말을 쪼갠다.
    cy.anchor("workflows.usage-budget").find("> header p").should("have.css", "word-break", "keep-all");
    // 계정 풀·소비자 목록은 660px 높이 뷰포트에서 접힌 아래에 있으므로 끌어와서 확인한다.
    cy.anchor("workflows.usage-budget.accounts").scrollIntoView().should("be.visible");
    cy.anchor("workflows.usage-budget.consumers").scrollIntoView().should("be.visible");
    // 격리 백엔드에는 페이싱 대상 워크플로가 없어 만들 자리도 없다. 안내는 HelpHint 안으로
    // 접혔으므로 생성 버튼과 구분해 물음표를 열고 문구를 확인한다.
    cy.get("[data-roundless-workflow]").should("not.exist");
    cy.anchor("workflows.usage-budget.consumers")
      .find(".usage-budget-trigger-toolbar .help-hint-trigger")
      .should("have.length", 1)
      .click();
    cy.get(".help-hint-popover")
      .should("be.visible")
      .and("contain.text", "회차가 없는 워크플로는 목록 아래에 행으로 드러나");
  });

  // 저장이 끝났는지 알리는 자리가 이 모달에는 없다. 그래서 성공하면 스스로 닫히는 것이
  // 유일한 신호다(QA #9 — 닫히지도 알리지도 않아 같은 버튼을 거듭 누르게 됐다).
  it("페이싱 스케줄 모달은 저장에 성공하면 스스로 닫힌다", () => {
    cy.anchor("workflows.tab.recurring").click();
    cy.anchor("workflows.usage-budget.schedule").click();
    cy.get(".modal .modal-title").should("contain.text", "페이싱 스케줄");
    cy.get(".modal .quiet-hours-form").contains("button", "저장").click();
    cy.get(".modal").should("not.exist");
    cy.get(".error-banner").should("not.exist");
  });

  it("예산 기본값 모달은 저장이 하나뿐이고 기준선 회차 수를 지우고 다시 넣을 수 있다", () => {
    cy.openPacingTab();
    cy.openBudgetDefaultsModal().within(() => {
      // 섹션마다 저장을 두면 어느 칸을 저장하는 버튼인지 모달 안에서 알 수 없다.
      // 저장은 바닥글 하나이고 목표·가드와 절감 목표를 함께 보낸다.
      cy.get(".modal-body").contains("button", "저장").should("not.exist");
      cy.get(".modal-footer").contains("button", "저장").should("exist");
      // 숫자 칸을 고치려면 먼저 지워야 한다. 지우는 순간 기본값이 다시 채워지면
      // 5에서 다른 값으로 갈 방법이 없다.
      cy.contains("label", "기준선 회차 수").find("input").as("baseline");
      cy.get("@baseline").should("have.value", "5").clear().should("have.value", "");
      cy.get("@baseline").type("8").should("have.value", "8");
      // 두 섹션을 함께 고쳐도 한 번의 저장으로 둘 다 남아야 한다. 섹션별 저장이던 때는
      // 한쪽을 저장하면 스냅샷을 다시 읽어 다른 섹션의 미저장 입력이 사라졌다.
      cy.contains("label", "목표 사용률(%)").find("input").clear().type("90");
      cy.get(".modal-footer").contains("button", "저장").click();
    });
    // 저장이 끝나면 모달이 닫히고, 다시 열면 저장된 값이 그대로 있다.
    cy.get(".modal").should("not.exist");
    cy.openBudgetDefaultsModal().contains("label", "기준선 회차 수").find("input").should("have.value", "8");
    cy.get(".modal").contains("label", "목표 사용률(%)").find("input").should("have.value", "90");
    // 저장하지 않고 닫은 입력은 남지 않는다. 초안은 패널 상태에 살아 있으므로 여는 자리에서
    // 저장값으로 되돌려야, 다시 열었을 때 보이는 값이 실제 저장값이다.
    cy.get(".modal").contains("label", "기준선 회차 수").find("input").clear().type("3");
    cy.get(".modal .modal-header .icon-button").click();
    cy.get(".modal").should("not.exist");
    cy.openBudgetDefaultsModal().contains("label", "기준선 회차 수").find("input").should("have.value", "8");
  });

  it("페이싱 카드가 좁은 화면에서도 머리줄과 지표가 겹치지 않고 설정은 모달에 있다", () => {
    cy.viewport(1008, 2048);
    cy.stubInvoke("get_usage_budget", usageBudget({
      defaults: { windowLabel: "7일", targetPercent: 100, guardWindowLabel: "5시간", guardPercent: 85 },
      activeConsumers: ["paced-run-with-long-name"],
      accounts: [
        pacingAccount({
          accountId: "claude-long-account",
          email: "tester-c@example.com",
          provider: "claude",
          pacingEnabled: true,
          overview: pacingAccountOverview({ usedPercent: 17, targetPercent: 100 }),
        }),
        pacingAccount({ accountId: "claude-tester-b", email: "tester-b@example.com", provider: "claude" }),
        pacingAccount({ accountId: "claude-tester-a", email: "tester-a@example.com", provider: "claude" }),
        pacingAccount({ accountId: "codex-tester-a", email: "tester-a@example.com", provider: "codex" }),
        pacingAccount({ accountId: "codex-tester-b", email: "tester-b@example.com", provider: "codex" }),
      ],
      pacingWorkflowIds: ["plan_usage_paced_runs"],
      consumers: [pacingConsumer({
        scheduleId: "paced-run-with-long-name",
        name: "OpenAI Codex 장시간 반복 실행 관리",
        workflowId: "plan_usage_paced_runs",
        maxTokensPerRun: 120000,
        maxCostPercentPerRun: 4.5,
        enforceCeiling: true,
        costs: {
          perProvider: { codex: { percentPerRun: 3.2, observationWeight: 1 } },
          perAccount: [
            { accountId: "claude-long-account", provider: "claude", tokensPerRun: 26419020, percentPerRun: 1.17, runs: 4 },
            { accountId: "claude-tester-b", provider: "claude", tokensPerRun: 21408808, percentPerRun: null, runs: 1 },
            { accountId: "claude-tester-a", provider: "claude", tokensPerRun: 22031037, percentPerRun: 2, runs: 3 },
            { accountId: "codex-tester-a", provider: "codex", tokensPerRun: null, percentPerRun: null, runs: 1 },
            { accountId: "codex-tester-b", provider: "codex", tokensPerRun: null, percentPerRun: null, runs: 1 },
          ],
          recordedRuns: 8,
          savings: {},
        },
      })],
    }));
    cy.anchor("workflows.tab.recurring").should("contain.text", "워크플로 페이싱").click();
    cy.anchor("workflows.usage-budget").should("be.visible");
    // 카드는 읽는 자리다. 머리줄(이름·상태)과 지표 격자가 겹치면 좁은 폭에서 값을 못 읽는다.
    cy.get(".usage-budget-card").should("have.length.at.least", 2).then(($cards) => {
      const card = $cards[$cards.length - 1] as HTMLElement;
      const head = card.querySelector(".usage-budget-card-head")?.getBoundingClientRect();
      const metrics = card.querySelector(".usage-budget-metrics")?.getBoundingClientRect();
      expect(head, "card head").to.exist;
      expect(metrics, "card metrics").to.exist;
      if (!head || !metrics) return;
      expect(head.bottom <= metrics.top, "card head and metrics do not overlap").to.equal(true);
    });
    // 계정 풀은 계정마다 소진율 막대로 읽힌다. 채운 길이가 사용률(17%)을 따라야 한다.
    cy.get(".usage-budget-pool-bars > li").should("have.length", 5).first().within(() => {
      cy.get("b").should("have.text", "17%");
      cy.get(".progress > span").should(($fill) => {
        const track = $fill.parent()[0].getBoundingClientRect().width;
        expect($fill[0].getBoundingClientRect().width / track).to.be.closeTo(0.17, 0.02);
      });
    });
    // 한 카드 안의 계정 비용은 공급자별로 묶이고, 이메일과 세 수치가 행마다 같은 열에 선다.
    cy.get('[data-schedule-id="paced-run-with-long-name"] .usage-budget-agent-costs').within(() => {
      cy.get("header").first().should("contain.text", "계정별 회당 소비").and("contain.text", "5개 계정");
      cy.get(".usage-budget-agent-cost-group").should("have.length", 2);
      cy.get(".usage-budget-agent-cost-group.source-claude li").should("have.length", 3);
      cy.get(".usage-budget-agent-cost-group.source-codex li").should("have.length", 2);
      cy.get(".usage-budget-agent-cost-group li").each(($row) => {
        const name = $row[0].querySelector(":scope > em")?.getBoundingClientRect();
        const metrics = $row[0].querySelector(":scope > dl")?.getBoundingClientRect();
        expect(name, "account name").to.exist;
        expect(metrics, "account metrics").to.exist;
        if (!name || !metrics) return;
        expect(name.right <= metrics.left, "account name and metrics do not overlap").to.equal(true);
      });
      // 공급자 배지는 SourceBadge가 span이라 헤더의 `> span` 규칙에 함께 걸리기 쉽다.
      // 걸리면 margin-left:auto를 받아 가운데로 밀리고 공급자 색도 회색에 덮인다.
      cy.get(".usage-budget-agent-cost-group > header").each(($header) => {
        const header = $header[0].getBoundingClientRect();
        const badge = $header[0].querySelector(":scope > .source-badge");
        const count = $header[0].querySelector(":scope > span:not(.source-badge)");
        expect(badge, "provider badge").to.exist;
        expect(count, "account count").to.exist;
        if (!badge || !count) return;
        const badgeBox = badge.getBoundingClientRect();
        expect(badgeBox.left - header.left, "badge hugs the header's left edge").to.be.lessThan(14);
        expect(count.getBoundingClientRect().left >= badgeBox.right, "count sits right of the badge").to.equal(true);
        // 스타일은 앱 프레임의 window로 읽어야 한다 — 스펙 window로는 다른 문서의 요소다.
        const view = badge.ownerDocument.defaultView;
        expect(view?.getComputedStyle(badge).color, "badge keeps its provider color").to.not.equal(view?.getComputedStyle(count).color);
      });
      cy.contains("dd", "26,419,020").should("be.visible");
    });
    // 편집 컨트롤은 카드가 아니라 설정 모달에만 있다.
    cy.get(".usage-budget-card .app-toggle").should("not.exist");
    cy.contains('[data-schedule-id="paced-run-with-long-name"] .usage-budget-card-actions .button', "편집").click();
    cy.get(".modal-backdrop .usage-budget-workflow-accounts").should("be.visible");
    cy.get(".modal-backdrop .app-toggle").should("have.length.at.least", 2);
    // 참여 계정은 칩이 아니라 계정마다 하나씩 서는 스위치다. 후보가 하나뿐이면 그 하나를
    // 끄면 "제한 없음"으로 뒤집히므로 스위치가 잠긴다.
    cy.get(".modal-backdrop .usage-budget-account-switches > li").should("have.length", 1);
    cy.get('.modal-backdrop .usage-budget-account-switches [role="switch"]')
      .should("have.attr", "aria-checked", "true")
      .and("be.disabled");
    cy.get(".modal-backdrop .modal-header .icon-button").click();
    cy.get(".modal-backdrop").should("not.exist");
  });

  // 회차 카드는 기본정보(반복주기·다음 실행·최근 실행)와 상세정보(다음 실행 계정·평균
  // 소진율·회당 소비·남은 예산·계정별 소비)로 갈린다. 넓으면 둘 다 펴 두고, 모바일처럼
  // 좁으면 상세정보를 접어 카드 하나가 화면을 넘기지 않게 한다.
  const stubOneRound = () => {
    cy.stubInvoke("get_usage_budget", usageBudget({
      accounts: [pacingAccount({
        accountId: "claude-tester-a",
        email: "tester-a@example.com",
        provider: "claude",
        pacingEnabled: true,
        overview: pacingAccountOverview({ usedPercent: 40, targetPercent: 95 }),
      })],
      pacingWorkflowIds: ["plan_usage_paced_runs"],
      consumers: [pacingConsumer({
        scheduleId: "paced-round",
        name: "페이싱 회차",
        workflowId: "plan_usage_paced_runs",
        costs: {
          perProvider: { claude: { percentPerRun: 2.5, observationWeight: 1 } },
          perAccount: [],
          recordedRuns: 4,
          savings: {},
        },
      })],
    }));
    cy.anchor("workflows.tab.recurring").click();
    cy.get('[data-schedule-id="paced-round"]').as("card");
  };

  it("넓은 화면에서 회차 카드는 기본정보와 상세정보를 함께 펴고 접을 수 있다", () => {
    cy.viewport(1200, 900);
    stubOneRound();
    // 기본정보는 반복주기·다음 실행·최근 실행 세 칸이다.
    cy.get("@card").find('[aria-label="기본 정보"] dt').should("have.length", 3);
    cy.get("@card").find('[aria-label="기본 정보"]').should("contain.text", "반복주기").and("contain.text", "최근 실행");
    cy.get("@card").find(".usage-budget-detail-toggle").should("have.attr", "aria-expanded", "true");
    cy.get("@card").find('[aria-label="상세 정보"]').scrollIntoView().should("be.visible").and("contain.text", "평균 소진율");
    // 넓어도 접을 수 있어야 한다 — 폭은 기본값만 정하고 사용자의 선택이 그 위에 온다.
    cy.get("@card").find(".usage-budget-detail-toggle").click();
    cy.get("@card").find(".usage-budget-detail-toggle").should("have.attr", "aria-expanded", "false");
    cy.get("@card").find('[aria-label="상세 정보"]').should("not.exist");
    // 접혀도 기본정보는 남는다.
    cy.get("@card").find('[aria-label="기본 정보"]').scrollIntoView().should("be.visible");
  });

  it("좁은 화면에서 회차 카드의 상세정보는 접힌 채로 오고 눌러야 펴진다", () => {
    cy.viewport(430, 900);
    stubOneRound();
    cy.get("@card").find('[aria-label="기본 정보"]').scrollIntoView().should("be.visible").and("contain.text", "반복주기");
    // 접혀 있어도 무엇이 접혔는지는 토글 줄의 요약으로 읽힌다.
    cy.get("@card").find(".usage-budget-detail-toggle")
      .should("have.attr", "aria-expanded", "false")
      .and("contain.text", "상세정보")
      .and("contain.text", "평균 소진율");
    cy.get("@card").find('[aria-label="상세 정보"]').should("not.exist");
    cy.get("@card").find(".usage-budget-detail-toggle").click();
    cy.get("@card").find(".usage-budget-detail-toggle").should("have.attr", "aria-expanded", "true");
    cy.get("@card").find('[aria-label="상세 정보"]').should("contain.text", "남은 예산");
  });
});

// 실행 버튼을 눌렀을 때 반응이 보이는지. 등록된 워크플로가 없는 격리 백엔드에서는 상세
// 패널 자체가 뜨지 않으므로 목록·상세 응답을 세워 두고 확인한다.
describe("워크플로 실행 버튼", () => {
  const INPUT_SCHEMA = {
    emailPrefix: { description: "이 문자열로 시작하는 계정만", label: "대상 계정 접두사", required: true, type: "string", values: null },
    maxRuns: { description: "한 회차 최대 건수", label: "회차 상한", required: true, type: "number", values: null },
  };
  const SUMMARY = workflowSummary({ description: "실행 버튼 회귀 확인용 계약", inputSchema: INPUT_SCHEMA });

  beforeEach(() => {
    stubWorkflowCatalog([SUMMARY], workflowDetail(SUMMARY));
    cy.visitApp();
    cy.openView("workflows");
  });

  it("필수 입력이 비면 버튼이 보이는 자리에서 무엇을 채워야 하는지 알려 준다", () => {
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    // 화면 맨 위 배너만 갱신하면 버튼을 보던 사용자에게는 아무 반응이 없다.
    cy.get(".workflow-input-problem").should("be.visible").and("contain.text", "대상 계정 접두사");
    cy.get(".workflow-inputs label.workflow-input-invalid").should("have.length", 2);
  });

  it("제목 옆 물음표가 계약 설명 전문을 연다", () => {
    cy.get(".workflow-detail-title h2 .help-hint-trigger").click();
    cy.get(".help-hint-popover").should("be.visible").and("contain.text", "실행 버튼 회귀 확인용 계약");
  });

  it("사용량을 쓰지 않는 계약에는 페이싱 표시가 없다", () => {
    cy.get('[data-ui-anchor="workflows.pacing-status"]').should("not.exist");
  });

  it("한 칸을 채우면 그 칸의 표시는 사라지고 남은 칸만 남는다", () => {
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".workflow-inputs input").eq(0).type("tester-");
    cy.get(".workflow-inputs label.workflow-input-invalid").should("have.length", 1);
  });

  it("필수 입력을 채우면 확인 대화상자가 뜬다", () => {
    cy.get(".workflow-inputs input").eq(0).type("tester-");
    cy.get(".workflow-inputs input").eq(1).type("1");
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".modal-backdrop .modal").should("be.visible").and("contain.text", "테스트 워크플로 실행");
  });

  it("실행이 실패하면 오류를 상세 패널 안에서 보여 준다", () => {
    cy.stubInvoke("execute_system_workflow", { statusCode: 500, body: { error: "실행 권한이 없습니다" } });
    cy.get(".workflow-inputs input").eq(0).type("tester-");
    cy.get(".workflow-inputs input").eq(1).type("1");
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    cy.get(".modal-backdrop .modal").contains("button", "실행").click();
    cy.get(".workflow-action-error .error-banner").should("be.visible");
  });
});

// 값이 매번 같은 워크플로는 상세를 열자마자 실행할 수 있어야 한다. 계약이 기본값을
// 선언하면 폼이 그 값에서 시작하고, 아무것도 입력하지 않아도 실행이 막히지 않는다.
describe("계약 기본값이 채워진 실행 폼", () => {
  const INPUT_SCHEMA = {
    emailPrefix: { defaultValue: "tester-", description: "이 문자열로 시작하는 계정만", label: "대상 계정 접두사", required: true, type: "string", values: null },
    maxRuns: { defaultValue: 1, description: "한 회차 최대 건수", label: "회차 상한", required: true, type: "number", values: null },
  };
  const SUMMARY = workflowSummary({
    contractDigest: "abc123def4567890",
    description: "기본값 프리필 회귀 확인용 계약",
    displayName: "기본값 워크플로",
    id: "wf-defaults",
    inputSchema: INPUT_SCHEMA,
  });

  beforeEach(() => {
    stubWorkflowCatalog([SUMMARY], workflowDetail(SUMMARY));
    cy.visitApp();
    cy.openView("workflows");
  });

  it("상세를 열면 선언된 기본값이 폼에 채워져 있고 바로 실행할 수 있다", () => {
    cy.get(".workflow-inputs input").eq(0).should("have.value", "tester-");
    cy.get(".workflow-inputs input").eq(1).should("have.value", "1");
    cy.get(".workflow-run-section header small").should("contain.text", "기본값 2개");
    cy.contains(".workflow-detail-actions .button", "워크플로 실행").scrollIntoView().click();
    // 채울 칸이 남지 않았으므로 필수 입력 안내 없이 확인 대화상자로 넘어간다.
    cy.get(".workflow-input-problem").should("not.exist");
    cy.get(".modal-backdrop .modal").should("be.visible").and("contain.text", "기본값 워크플로 실행");
  });
});

// 페이싱 대상 여부는 계약이 정한다(사용자 설정 없음). 목록 배지와 상세 표시가 같은 값을
// 보여야 하고, 상세에는 켜고 끄는 조작이 없어야 한다.
describe("워크플로별 페이싱 표시", () => {
  const SUMMARY = workflowSummary({
    contractDigest: "feed0000beef1111",
    description: "무인 런타임을 띄우는 회차 계약",
    displayName: "페이싱 워크플로",
    id: "wf-paced",
    pacingCapable: true,
    pacingEnabled: true,
    requiredOperations: ["start_chat"],
  });

  // 페이싱 표시는 "대상 계약"이 아니라 "지금 도는 회차"가 근거다. 켜진 회차 하나를 깔아 둔다.
  const ROUND = {
    id: "schedule-paced",
    name: "페이싱 회차",
    enabled: true,
    workflow: { workflowId: "wf-paced", approvedVersion: 1, arguments: {} },
  };

  beforeEach(() => {
    stubWorkflowCatalog([SUMMARY], workflowDetail(SUMMARY));
    cy.stubInvoke("get_scheduler_snapshot", { paused: false, runnerActive: true, schedules: [ROUND], runs: [] });
    cy.visitApp();
    cy.openView("workflows");
  });

  it("회차가 돌고 있으면 배지와 상태 표시가 뜨고 켜고 끄는 조작은 없다", () => {
    cy.get(".workflow-card-badges .paced").should("contain.text", "페이싱");
    cy.anchor("workflows.pacing-status").scrollIntoView().should("contain.text", "사용량 페이싱");
    cy.get('[data-ui-anchor="workflows.pacing-status"] .app-toggle').should("not.exist");
  });

  // 회차가 없거나 멈춰 있으면 예산이 통제할 일이 없다 — 페이싱이 도는 것처럼 보이면 안 된다.
  it("회차가 멈춰 있으면 페이싱 표시도 배지도 붙지 않는다", () => {
    cy.stubInvoke("get_scheduler_snapshot", {
      paused: false,
      runnerActive: true,
      schedules: [{ ...ROUND, enabled: false }],
      runs: [],
    });
    cy.visitApp();
    cy.anchor("nav.workflows").click();
    cy.get(".workflow-card-badges .paced").should("not.exist");
    cy.get('[data-ui-anchor="workflows.pacing-status"]').should("not.exist");
  });
});

// 회차가 있는 워크플로에 트리거를 하나 더 달면 같은 작업이 두 소비자로 갈라진다. 생성은
// 회차 없는 워크플로에만 열리고, 회차 없는 페이싱 워크플로는 목록에 행으로 드러나야 한다.
describe("페이싱 회차 생성 가드", () => {
  const WORKFLOW = workflowSummary({
    contractDigest: "feed0000beef1111",
    description: "무인 런타임을 띄우는 회차 계약",
    displayName: "회차 있는 워크플로",
    id: "wf-paced",
    pacingCapable: true,
    pacingEnabled: true,
    requiredOperations: ["start_chat"],
  });
  const FRESH = { ...WORKFLOW, id: "wf-fresh", displayName: "회차 없는 워크플로" };
  const BUDGET = usageBudget({
    activeConsumers: ["schedule-paced"],
    pacingWorkflowIds: ["wf-paced", "wf-fresh"],
    consumers: [pacingConsumer({
      scheduleId: "schedule-paced",
      name: "돌고 있는 회차",
      workflowId: "wf-paced",
    })],
  });

  const openPacingTab = () => {
    cy.visitApp();
    cy.openPacingTab();
  };

  it("회차 없는 페이싱 워크플로는 행으로 드러나고 페이싱 추가가 그 워크플로를 미리 고른다", () => {
    stubWorkflowCatalog([WORKFLOW, FRESH]);
    cy.stubInvoke("get_usage_budget", BUDGET);
    openPacingTab();
    cy.get('[data-roundless-workflow="wf-fresh"]').scrollIntoView().should("contain.text", "회차가 없어");
    cy.get('[data-roundless-workflow="wf-paced"]').should("not.exist");
    cy.get('[data-roundless-workflow="wf-fresh"] button').click();
    // 생성 모달의 선택지는 회차 없는 워크플로뿐이고("워크플로 선택" 자리 표시 + wf-fresh),
    // 행에서 왔으므로 그 워크플로가 미리 골라져 있다.
    cy.get(".modal-backdrop select").first().should("have.value", "wf-fresh").find("option").should("have.length", 2);
  });

  // 회차를 지우면 소비자 설정만 남는다. 그 찌꺼기를 회차로 세면 그 워크플로는 다시는
  // 회차를 만들지 못한다 — 목록에서도 빠지고 생성이 다시 열려야 한다.
  it("반복 요청이 지워진 소비자는 목록에서 빠지고 회차를 다시 만들 수 있다", () => {
    stubWorkflowCatalog([WORKFLOW]);
    cy.stubInvoke("get_usage_budget", {
      ...BUDGET,
      activeConsumers: [],
      pacingWorkflowIds: ["wf-paced"],
      consumers: [{ ...BUDGET.consumers[0], scheduleExists: false, scheduleEnabled: null, cadenceMinutes: null }],
    });
    openPacingTab();
    cy.get('[data-schedule-id="schedule-paced"]').should("not.exist");
    cy.get('[data-roundless-workflow="wf-paced"]').scrollIntoView().should("contain.text", "회차가 없어");
    cy.get('[data-roundless-workflow="wf-paced"] button').should("be.enabled");
  });

  it("모든 페이싱 워크플로에 회차가 있으면 만들 자리가 없다", () => {
    stubWorkflowCatalog([WORKFLOW]);
    cy.stubInvoke("get_usage_budget", { ...BUDGET, pacingWorkflowIds: ["wf-paced"] });
    openPacingTab();
    cy.get("[data-roundless-workflow]").should("not.exist");
    cy.anchor("workflows.usage-budget.consumers")
      .find(".usage-budget-trigger-toolbar .help-hint-trigger")
      .should("have.length", 1);
  });

  // 처리량 판정은 회차별로 온다(consumers[].throughput). 스냅샷 최상위 throughput은 구형 화면
  // 호환용이라 새 화면은 읽지 않는다.
  const interceptShortThroughput = (recommendedMaxRuns: number | null) => {
    stubWorkflowCatalog([WORKFLOW]);
    cy.stubInvoke("get_usage_budget", {
      ...BUDGET,
      pacingWorkflowIds: ["wf-paced"],
      accounts: [pacingAccount({
        accountId: "claude-a",
        email: "a@example.com",
        provider: "claude",
        displayName: "Claude A",
        pacingEnabled: true,
        overview: pacingAccountOverview({ usedPercent: 50, targetPercent: 95 }),
      })],
      consumers: [{
        ...BUDGET.consumers[0],
        throughput: {
          demandPercentPerHour: 2,
          supplyPercentPerHour: 1,
          reachesTarget: false,
          rounds: [{
            scheduleId: "schedule-paced",
            maxRuns: 1,
            cadenceMinutes: 300,
            runMinutes: 30,
            costPercentPerRun: 2.5,
            supplyPercentPerHour: 1,
            recommendedMaxRuns,
          }],
        },
      }],
    });
  };

  // 동시 기동 건수는 입력 중 문자열로 들고 있어야 한다. 숫자 상태로 두면 첫 자리를 지운
  // 순간 0이 남아 "020"이 된다.
  it("동시 기동 건수는 첫 자리를 지우고 다시 입력해도 0이 앞에 붙지 않는다", () => {
    // 병렬 블록은 계약이 페이싱일 때만 뜬다(paced 또는 pacingMode=envelope).
    stubWorkflowCatalog([WORKFLOW, { ...FRESH, paced: true }]);
    cy.stubInvoke("get_usage_budget", BUDGET);
    openPacingTab();
    cy.get('[data-roundless-workflow="wf-fresh"] button').click();
    cy.get(".modal-backdrop").contains("label", "병렬 실행").find('input[type="checkbox"]').check();
    cy.get(".modal-backdrop").contains("label", "동시 기동 건수").find('input[type="number"]')
      .should("have.value", "2")
      .clear()
      .type("20")
      .should("have.value", "20");
    cy.get(".modal-backdrop .schedule-workflow-note").should("contain.text", "최대 20건");
    // 비운 채 포커스를 옮기면 최소값으로 돌아온다.
    cy.get(".modal-backdrop").contains("label", "동시 기동 건수").find('input[type="number"]').clear().blur();
    cy.get(".modal-backdrop").contains("label", "동시 기동 건수").find('input[type="number"]').should("have.value", "2");
  });

  it("풀 처리량이 모자라면 회차 카드에 경고와 병렬 권장을 표시한다", () => {
    interceptShortThroughput(2);
    openPacingTab();
    cy.get(".usage-budget-throughput-warning")
      .scrollIntoView()
      .should("be.visible")
      .and("contain.text", "이 회차 설정으로는 목표를 못 채웁니다")
      .and("contain.text", "이 회차를 병렬 2건으로 올리면 채웁니다");
  });

  it("병렬 권장은 상한 없이 계산된 값을 그대로 보여준다", () => {
    // 병렬 실행에 상한이 없으므로 옛 상한 12를 넘는 권장치도 숫자로 보인다.
    interceptShortThroughput(47);
    openPacingTab();
    cy.get(".usage-budget-throughput-warning")
      .scrollIntoView()
      .should("contain.text", "이 회차를 병렬 47건으로 올리면 채웁니다");
  });

  it("권장치를 계산할 수 없으면 회당 소비 미측정 안내를 보여준다", () => {
    interceptShortThroughput(null);
    openPacingTab();
    cy.get(".usage-budget-throughput-warning")
      .scrollIntoView()
      .should("contain.text", "회당 소비를 아직 재지 못해")
      .and("not.contain.text", "상한");
  });
});
