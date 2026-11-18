import { providerAccount, providerState } from "../support/providerAccountFixtures";

// 페일오버 우선순위 입력은 한도 페일오버 방식이 '우선순위'일 때만 계정 관리 메뉴 안에 나타나고,
// 초점을 잃을 때 1~999 범위와 변경 여부를 스스로 판정해 저장을 부른다(SettingsView.tsx:2534).
// 범위 밖 값이 조용히 저장되면 페일오버 순서가 사용자가 본 것과 달라지고, 같은 값에도 저장을
// 부르면 계정 스냅샷이 불필요하게 교체된다. 경계값·빈 값·무변경을 한 번에 확인한다.
describe("계정 페일오버 우선순위 입력의 경계값과 저장 호출", () => {
  const accountId = "codex-priority-bounds";
  const label = "페일오버 대상";
  const account = providerAccount({
    id: accountId,
    isActive: false,
    displayName: label,
    label,
    providerDisplayName: "Codex QA",
    providerAccountId: "codex-priority-account",
    autoSwitch: true,
    autoSwitchPriority: 3,
  });
  const provider = providerState({ activeAccountId: null, observedActiveAccountId: null });
  const snapshot = (priority: number | null) => ({
    accounts: [{ ...account, autoSwitchPriority: priority }],
    providers: [provider],
    autoSwitchResume: false,
    // 우선순위 입력은 이 방식일 때만 그려진다.
    autoSwitchPolicy: "priority",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
  });

  beforeEach(() => {
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: snapshot(3) });
    // 기동 직후의 일괄 사용량 갱신도 같은 스냅샷을 돌려줘야 등록 계정이 0건으로 덮이지 않는다.
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: snapshot(3) });
    cy.stubInvoke("set_provider_account_auto_switch_priority", { statusCode: 200, body: snapshot(7) }).as("savePriority");
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.get(".provider-account-row").contains("strong", label).should("exist");
  });

  const openMenu = () => cy.get('button[aria-label="계정 관리 메뉴"]').click({ force: true });
  const priorityInput = () => cy.get(`input[aria-label="${label} 페일오버 우선순위"]`);

  it("범위 밖과 무변경은 저장을 부르지 않고 경계값과 빈 값만 저장한다", () => {
    openMenu();
    priorityInput().should("have.value", "3").and("have.attr", "min", "1").and("have.attr", "max", "999");

    // 하한 아래 — 저장하지 않고 칸도 저장본으로 돌아온다.
    priorityInput().clear().type("0").blur();
    cy.get("@savePriority.all").should("have.length", 0);
    priorityInput().should("have.value", "3");

    // 상한 위 — 저장을 부르지 않고, 거부된 값을 칸에 남기지 않는다. 한때 1000이 그대로
    // 남아 사용자는 그 값이 반영된 것으로 읽었다(QA #89).
    priorityInput().clear().type("1000").blur();
    cy.get("@savePriority.all").should("have.length", 0);
    priorityInput().should("have.value", "3");

    // 저장본과 같은 값 — 다시 저장하지 않는다
    priorityInput().clear().type("3").blur();
    cy.get("@savePriority.all").should("have.length", 0);

    // 상한 경계값은 저장한다
    priorityInput().clear().type("999").blur();
    cy.wait("@savePriority").its("request.body").should("deep.equal", { accountId, priority: 999 });
  });

  it("빈 값은 우선순위를 비우고 하한 경계값은 그대로 저장한다", () => {
    openMenu();
    priorityInput().clear().blur();
    cy.wait("@savePriority").its("request.body").should("deep.equal", { accountId, priority: null });

    // 저장 뒤에도 메뉴는 열린 채이므로 다시 열지 않고 이어서 하한 경계값을 넣는다.
    priorityInput().clear().type("1").blur();
    cy.wait("@savePriority").its("request.body").should("deep.equal", { accountId, priority: 1 });
  });
});
