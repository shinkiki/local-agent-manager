import {
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";

// 계정 표시 이름과 메모 편집기는 같은 모달 뼈대와 훅을 공유한다. 한 편집기의 취소 초안이나
// 저장 오류가 다른 편집기로 새면 계정을 구분하려던 사용자가 엉뚱한 값을 저장할 수 있으므로,
// 두 대화상자를 번갈아 열어 상태가 서로 격리되고 다시 열 때 저장본에서 시작하는지 확인한다.
describe("계정 표시 이름·메모 편집 대화상자의 초안과 오류 상태 격리", () => {
  const accountId = "codex-draft-isolation";
  const savedLabel = "배포 계정";
  const savedNote = "운영 배포 전용";
  const account = providerAccount({
    id: accountId,
    displayName: savedLabel,
    label: savedLabel,
    providerDisplayName: "Codex Team",
    providerAccountId: "codex-team-account",
    email: "qa@example.invalid",
    organization: "QA 조직",
    note: savedNote,
    authStatus: "ready",
  });
  const provider = providerState({ activeAccountId: accountId, observedActiveAccountId: accountId });
  const snapshot = (patch: Record<string, unknown> = {}) => ({
    accounts: [{ ...account, ...patch }],
    providers: [provider],
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
  });

  beforeEach(() => {
    stubProviderAccounts([provider], [account]);
    // 앱 기동 직후의 일괄 사용량 갱신도 계정 스냅샷을 교체하므로 같은 계정을 돌려준다.
    // 이 경로를 실제 격리 백엔드에 흘리면 등록 계정 0건 응답이 위 스텁을 덮어쓴다.
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: snapshot() });
    cy.visitApp();
    cy.openSettingsTab("connections");
    accountRow().should("exist");
  });

  const accountRow = () => cy.get(".provider-account-row").contains("strong", savedLabel).closest(".provider-account-row");

  const openMenuItem = (label: string) => {
    cy.get('button[aria-label="계정 관리 메뉴"]').click({ force: true });
    cy.contains('[role="menuitem"]', label).click({ force: true });
  };

  it("취소한 초안과 실패 오류가 이웃 편집기로 새지 않고 각 저장본에서 다시 시작한다", () => {
    openMenuItem("표시 이름 변경");
    cy.get('[role="dialog"]').as("modal").should("contain.text", "표시 이름 변경");
    cy.get('@modal').find('input[aria-label="계정 표시 이름"]')
      .should("have.value", savedLabel)
      .clear()
      .type("취소할 표시 이름");
    cy.get("@modal").contains("button", "취소").click();
    cy.get('[role="dialog"]').should("not.exist");

    openMenuItem("표시 이름 변경");
    cy.get('[role="dialog"] input[aria-label="계정 표시 이름"]')
      .should("have.value", savedLabel)
      .clear()
      .type("실패할 표시 이름");
    cy.stubInvoke("set_provider_account_label", {
      statusCode: 500,
      body: { message: "QA 표시 이름 저장 실패" },
    }).as("saveLabel");
    cy.get('[role="dialog"]').contains("button", "저장").click();
    cy.wait("@saveLabel").its("request.body").should("deep.equal", {
      accountId,
      label: "실패할 표시 이름",
    });
    cy.get('[role="dialog"]')
      .should("contain.text", "요청을 처리하지 못했습니다")
      .find('input[aria-label="계정 표시 이름"]')
      .should("have.value", "실패할 표시 이름");
    cy.get('[role="dialog"]').contains("button", "취소").click();

    openMenuItem("메모 편집");
    cy.get('[role="dialog"]').as("noteModal")
      .should("contain.text", `${savedLabel} 메모`)
      .and("not.contain.text", "요청을 처리하지 못했습니다");
    cy.get('@noteModal').find(`textarea[aria-label="${savedLabel} 계정 메모"]`)
      .should("have.value", savedNote)
      .clear()
      .type("새로 저장한 메모");
    cy.stubInvoke("set_provider_account_note", {
      statusCode: 200,
      body: snapshot({ note: "새로 저장한 메모" }),
    }).as("saveNote");
    cy.get("@noteModal").contains("button", "저장").click();
    cy.wait("@saveNote").its("request.body").should("deep.equal", {
      accountId,
      note: "새로 저장한 메모",
    });
    cy.get('[role="dialog"]').should("not.exist");
    accountRow().find(".provider-account-note").should("contain.text", "새로 저장한 메모");

    openMenuItem("표시 이름 변경");
    cy.get('[role="dialog"]')
      .should("not.contain.text", "요청을 처리하지 못했습니다")
      .find('input[aria-label="계정 표시 이름"]')
      .should("have.value", savedLabel);
  });
});
