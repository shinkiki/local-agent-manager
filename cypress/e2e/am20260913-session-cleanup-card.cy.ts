/// <reference types="cypress" />
// 세션 자동정리(`C11`) 카드는 두 갈래를 갈라 말해야 한다 — 목록에서 내리는 몫과 실체를
// 회수하는 몫은 같지 않다. 공유 공급자 홈의 원문은 지우지 않으므로 대부분의 세션은
// "목록에서만 내림"이 되고, 용량이 실제로 도는 것은 앱 데이터 안에 있는 것뿐이다.
//
// 조건별 적중 건수도 함께 봐야 한다. 보존 기간처럼 켜 두면 뭔가 하는 줄 알기 쉬운 조건이
// 실제로 몇 건을 잡는지는 데이터마다 다르고, 0건이면 0건이라고 말해야 한다.
//
// get_session_cleanup_status 응답만 가로챈다. 버튼은 누르지 않으므로 실제 정리는 돌지 않는다.
const status = (overrides: Record<string, unknown> = {}) => ({
  policy: {
    enabled: false,
    retentionDays: 90,
    maxMessageCount: 1,
    perProviderCap: 400,
    perAutomationCap: 30,
    hiddenAfterDays: 7,
    trashRetentionDays: 14,
    intervalHours: 24,
  },
  lastRunAt: null,
  nextRunAt: null,
  sessionCount: 2866,
  tombstoneCount: 0,
  preview: {
    targetCount: 2146,
    removableCount: 396,
    removableBytes: 490 * 1024 * 1024,
    protectedCount: 12,
    remainingCount: 720,
    byReason: [
      { reason: "emptySession", label: "빈 세션", count: 874 },
      { reason: "providerCap", label: "공급자별 상한 초과", count: 61 },
      { reason: "automationCap", label: "일정별 회차 상한 초과", count: 1174 },
      { reason: "retention", label: "보존 기간 경과", count: 37 },
      { reason: "hiddenAged", label: "보관 후 경과", count: 0 },
    ],
    orphanAttachmentCount: 0,
    orphanAttachmentBytes: 0,
  },
  receipts: [],
  ...overrides,
});

function openCard(overrides: Record<string, unknown> = {}) {
  cy.stubInvoke("get_session_cleanup_status", { statusCode: 200, body: status(overrides) });
  cy.visitApp();
  cy.openView("storage");
  cy.anchor("storage.tab.data").click();
  // 카드는 저장소 → 데이터 탭 맨 아래라 첫 화면 밖에 있다. 잘려 있다고 `be.visible`이 실패하므로
  // 끌어올려 놓고 본다.
  cy.anchor("storage.session-cleanup").scrollIntoView().should("exist");
}

describe("세션 자동정리 카드", () => {
  it("목록에서 내리는 몫과 실체를 회수하는 몫을 갈라 말한다", () => {
    openCard();
    cy.anchor("storage.session-cleanup").within(() => {
      cy.contains(".settings-update-status small", "세션 2,146건")
        .should("contain.text", "실체 회수 396건 490MB")
        // 공급자 홈 원문은 지우지 않으므로 나머지는 목록에서만 내려간다.
        .and("contain.text", "목록에서만 내림 1,750건");
      cy.get(".session-cleanup-factor").should("contain.text", "정리 후 720건").and("contain.text", "4.0배 축소");
    });
  });

  it("조건별 적중 건수를 보여 주고, 0건인 조건도 숨기지 않는다", () => {
    openCard();
    cy.anchor("storage.session-cleanup").within(() => {
      cy.get(".session-cleanup-condition").should("have.length", 5);
      cy.get(".session-cleanup-condition .app-toggle[role=switch]")
        .should("have.length", 5)
        .and("have.attr", "aria-checked", "true");
      cy.contains(".session-cleanup-condition", "빈 세션")
        .find(".session-cleanup-hint")
        .should("have.text", "현재 데이터에서 874건이 해당됩니다.");
      // 보존 기간은 켜져 있어도 37건뿐이라는 사실이 설정 화면에서 그대로 드러나야 한다.
      cy.contains(".session-cleanup-condition", "보존 기간")
        .find(".session-cleanup-hint")
        .should("have.text", "현재 데이터에서 37건이 해당됩니다.");
      cy.contains(".session-cleanup-condition", "보관 세션")
        .find(".session-cleanup-hint")
        .should("have.text", "현재 데이터에서는 해당되는 세션이 없습니다.");
    });
  });

  it("자동 실행 상한을 사용자 대화 상한과 따로 보여 준다", () => {
    // 상한을 공급자 하나로만 세면 매일 도는 보고가 사용자 대화를 밀어낸다. 두 통이
    // 갈라져 있다는 사실이 설정 화면에서 보여야 한다.
    openCard();
    cy.anchor("storage.session-cleanup").within(() => {
      cy.contains(".session-cleanup-condition", "자동 실행 상한")
        .find(".session-cleanup-hint")
        .should("contain.text", "일정마다 따로 셉니다")
        .and("contain.text", "사용자 대화를 밀어내지 않습니다")
        .and("contain.text", "1,174건이 해당됩니다");
      cy.contains(".session-cleanup-condition", "자동 실행 상한")
        .find(".session-cleanup-unit")
        .should("have.text", "건만 남김(일정별)");
      cy.contains(".session-cleanup-condition", "사용자 대화 상한")
        .find(".session-cleanup-hint")
        .should("contain.text", "61건이 해당됩니다");
    });
  });

  it("정리 기록이 없으면 되돌리기 버튼이 잠긴다", () => {
    openCard();
    cy.anchor("storage.session-cleanup").contains("button", "정리 기록 비우기").should("be.disabled");
  });

  it("정리 기록이 있으면 되돌리기가 열리고 건수를 말한다", () => {
    openCard({ tombstoneCount: 2146 });
    cy.anchor("storage.session-cleanup").within(() => {
      cy.contains(".settings-update-status small", "목록에서 내린 2,146건");
      cy.contains("button", "정리 기록 비우기").should("not.be.disabled");
    });
  });

  it("켜기 전에 무엇을 지울지 확인창으로 보여 준다", () => {
    openCard();
    cy.anchor("storage.session-cleanup")
      .find('.session-cleanup-auto-toggle [role="switch"]')
      .should("have.attr", "aria-checked", "false")
      .scrollIntoView()
      .click();
    // 제목과 버튼은 Modal 껍데기에 있고, 본문·대상 목록·경고만 `.confirm-dialog` 안이다.
    cy.get(".modal-title").should("contain.text", "세션 자동정리를 켤까요?");
    cy.get(".confirm-dialog").within(() => {
      cy.contains("지금 조건이라면 2,146건을 정리합니다.");
      cy.contains("앞으로 24시간마다 확인 없이 실행됩니다.");
      cy.contains("실체 회수 396건 · 490MB");
      cy.contains("목록에서만 내림 1,750건 (공급자 홈 원문은 그대로)");
      cy.get(".confirm-dialog-warning").should("contain.text", "지운 실체는 휴지통에 14일 보관한 뒤 완전 삭제됩니다.");
    });
    // 취소하면 아무것도 저장하지 않는다.
    cy.get(".modal-footer").contains("button", "취소").click();
    cy.get(".confirm-dialog").should("not.exist");
    cy.anchor("storage.session-cleanup")
      .find('.session-cleanup-auto-toggle [role="switch"]')
      .should("have.attr", "aria-checked", "false");
  });

  it("조건 숫자는 타이핑 중에 저장하지 않고 포커스를 벗어날 때 한 번만 올린다", () => {
    // 저장본을 그대로 입력칸에 물리면 "300"을 치는 동안 3과 30이 각각 저장되고, 하한에
    // 걸린 중간값이 입력칸을 덮어써 타이핑이 뒤집힌다.
    openCard();
    cy.stubInvoke("set_session_cleanup_policy", (req) => {
      req.reply({ statusCode: 200, body: status({ policy: { ...status().policy, perProviderCap: 250 } }) });
    }).as("savePolicy");

    cy.contains(".session-cleanup-condition", "사용자 대화 상한")
      .find("input[type=number]")
      .scrollIntoView()
      .clear()
      .type("250");
    // 아직 저장하지 않았고, 친 글자가 그대로 남아 있어야 한다.
    cy.contains(".session-cleanup-condition", "사용자 대화 상한")
      .find("input[type=number]")
      .should("have.value", "250");
    cy.get("@savePolicy.all").should("have.length", 0);

    cy.contains(".session-cleanup-condition", "사용자 대화 상한").find("input[type=number]").blur();
    cy.wait("@savePolicy").its("request.body.request.perProviderCap").should("equal", 250);
    cy.get("@savePolicy.all").should("have.length", 1);
  });

  it("하한 미만으로 확정하면 하한으로 올려 보낸다", () => {
    openCard();
    cy.stubInvoke("set_session_cleanup_policy", { statusCode: 200, body: status() }).as("savePolicy");
    cy.contains(".session-cleanup-condition", "사용자 대화 상한")
      .find("input[type=number]")
      .scrollIntoView()
      .clear()
      .type("3")
      .blur();
    cy.wait("@savePolicy").its("request.body.request.perProviderCap").should("equal", 10);
  });

  it("상태 조회가 실패하면 카드를 접지 않고 실패를 말하며 다시 시도할 수 있다", () => {
    // `return null`로 접으면 오류 배너까지 함께 사라져 아무 일도 없었던 화면이 된다.
    let attempt = 0;
    cy.stubInvoke("get_session_cleanup_status", (req) => {
      attempt += 1;
      if (attempt === 1) {
        req.reply({ statusCode: 500, body: { error: "정리 상태를 읽지 못했습니다" } });
        return;
      }
      req.reply({ statusCode: 200, body: status() });
    });
    cy.visitApp();
    cy.openView("storage");
    cy.anchor("storage.tab.data").click();
    cy.anchor("storage.session-cleanup").scrollIntoView().should("exist");
    cy.anchor("storage.session-cleanup").within(() => {
      cy.contains("상태를 읽지 못했습니다");
      cy.get(".error-banner").should("contain.text", "정리 상태를 읽지 못했습니다");
      cy.contains("button", "다시 시도").click();
    });
    // 다시 시도하면 정상 카드로 돌아온다.
    cy.anchor("storage.session-cleanup").within(() => {
      cy.get(".error-banner").should("not.exist");
      cy.get(".session-cleanup-condition").should("have.length", 5);
    });
  });

  it("빈 세션 기준은 상한을 넘겨 확정할 수 없다", () => {
    // 이 조건만 방향이 반대다 — 크게 잡을수록 더 지운다. 0을 하나 더 찍는 실수 하나로
    // 목록 전체가 대상이 되면 안 된다.
    openCard();
    cy.stubInvoke("set_session_cleanup_policy", { statusCode: 200, body: status() }).as("savePolicy");
    cy.contains(".session-cleanup-condition", "빈 세션")
      .find("input[type=number]")
      .scrollIntoView()
      .clear()
      .type("1000")
      .blur();
    cy.wait("@savePolicy").its("request.body.request.maxMessageCount").should("equal", 100);
  });

  it("최근 정리 목록은 실패한 회차를 따로 표시한다", () => {
    openCard({
      lastRunAt: 1757000000000,
      receipts: [
        {
          startedAt: 1757000000000,
          finishedAt: 1757000009000,
          manual: false,
          tombstonedCount: 2146,
          removedCount: 396,
          skippedCount: 12,
          skippedReasons: [{ reason: "반복 요청이 이어갈 세션이어서 건너뛰었습니다", count: 12 }],
          failedCount: 2,
          bytesFreed: 490 * 1024 * 1024,
          trashPurgedCount: 0,
          entriesTruncated: true,
          entries: [],
        },
      ],
    });
    cy.anchor("storage.session-cleanup").within(() => {
      cy.get(".session-cleanup-receipts li").should("have.length", 1).and("have.class", "failed");
      cy.get(".session-cleanup-receipts li small")
        .should("contain.text", "자동")
        .and("contain.text", "목록에서 2,146건 내림")
        .and("contain.text", "실패 2건");
    });
  });
});
