import { accountUsage, providerAccount, providerState } from "../support/providerAccountFixtures";

// Antigravity가 2026-09-17부터 등록 계정을 관리하면서 반복 요청 편집기도 공급자 목록을
// 하드코딩하지 않고 계정 스냅숏의 providers를 따라 실행 계정을 묻게 됐다
// (src/components/ChatSchedules.tsx:361, 513-519). 기존 반복 요청 스펙은 Claude 계정이나
// 계정 0건만 다뤘고, Antigravity 공급자 전환 뒤 활성 계정 표시·사용 가능 계정 필터·저장
// 봉투의 accountId를 한 화면 흐름으로 확인하지 않았다.

const activeAccount = providerAccount({
  id: "antigravity-active-qa",
  provider: "antigravity",
  displayName: "Antigravity 기본 QA",
  providerAccountId: "antigravity-active-provider-id",
  providerDisplayName: "Antigravity 기본 QA",
  authStatus: "ready",
});

const selectableAccount = providerAccount({
  id: "antigravity-selectable-qa",
  provider: "antigravity",
  displayName: "Antigravity 보조 QA",
  providerAccountId: "antigravity-selectable-provider-id",
  providerDisplayName: "Antigravity 보조 QA",
  isActive: false,
  authStatus: "ready",
});

const disabledAccount = providerAccount({
  id: "antigravity-disabled-qa",
  provider: "antigravity",
  displayName: "Antigravity 비활성 QA",
  providerAccountId: "antigravity-disabled-provider-id",
  providerDisplayName: "Antigravity 비활성 QA",
  isActive: false,
  disabled: true,
  authStatus: "ready",
});

const snapshot = {
  accounts: [activeAccount, selectableAccount, disabledAccount],
  providers: [providerState({
    provider: "antigravity",
    activeAccountId: activeAccount.id,
    observedActiveAccountId: activeAccount.id,
  })],
  autoSwitchResume: false,
  autoSwitchPolicy: "registration",
  autoSwitchUsageGapPercent: null,
  resumeAccountPolicy: "activeAccount",
};

function field(label: string) {
  return cy.get(".schedule-editor").contains("label > span", new RegExp(`^${label}$`)).parent();
}

describe("Antigravity 등록 계정의 반복 요청 실행계정 선택", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        const body = res.body as { status: { providers: Array<{ provider: string; cli: { detected: boolean } }> } };
        const antigravity = body.status.providers.find((provider) => provider.provider === "antigravity");
        if (antigravity) antigravity.cli.detected = true;
      });
    });
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: snapshot });
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: snapshot });
    cy.stubInvoke("get_antigravity_usage", { statusCode: 200, body: accountUsage() });
    cy.stubInvoke("create_scheduled_request", { statusCode: 200, body: null }).as("createSchedule");

    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("공급자 전환 뒤 활성·사용 가능 계정만 보이고 고른 계정 ID를 저장 봉투에 싣는다", () => {
    field("공급자").find("select").select("antigravity");

    field("실행 계정").find("select").should("have.value", activeAccount.id).within(() => {
      cy.get(`option[value="__active__"]`).should("contain.text", "지금은 Antigravity 기본 QA");
      cy.get(`option[value="${activeAccount.id}"]`).should("contain.text", "Antigravity 기본 QA · 활성");
      cy.get(`option[value="${selectableAccount.id}"]`).should("contain.text", "Antigravity 보조 QA");
      cy.get(`option[value="${disabledAccount.id}"]`).should("not.exist");
    });

    field("실행 계정").find("select").select(selectableAccount.id);
    field("반복할 요청").find("textarea").type("Antigravity 계정으로 격리 회차를 실행해줘");
    field("작업 경로").find("input").clear().type("/tmp/am-antigravity-account-qa");
    cy.get(".schedule-editor").contains("label", "저장 후 활성화").find("input").uncheck();
    cy.get('.schedule-editor footer button[type="submit"]').click();

    cy.wait("@createSchedule").its("request.body.request").should((request) => {
      expect(request).to.include({
        source: "antigravity",
        accountId: selectableAccount.id,
        useActiveAccount: false,
        cwd: "/tmp/am-antigravity-account-qa",
        enabled: false,
      });
    });
    cy.get(".schedule-editor").should("not.exist");
  });
});
