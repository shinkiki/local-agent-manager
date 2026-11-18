import { providerAccount, providerState } from "../support/providerAccountFixtures";

// 자격증명 사슬은 토큰을 회전해도 수명이 늘지 않아, 만료 시각을 넘기면 갱신이 거부되고
// 재인증 말고는 되살릴 길이 없다. 그래서 계정 카드는 만료 사흘 전부터 남은 기간을 미리
// 적는다(SettingsView.tsx `AccountExpiryNotice`). 창 안·창 밖·이미 만료된 계정이 한 화면에
// 서 있을 때 예고가 정확히 창 안 계정에만 붙는지를 본다 — 창 밖까지 붙으면 매일 재인증을
// 재촉하고, 이미 만료된 계정에 붙으면 아직 여유가 있는 것처럼 읽힌다.
describe("계정 카드의 인증 만료 예고", () => {
  const DAY = 86_400_000;
  const account = (label: string, credentialExpiresAt: number | null) => providerAccount({
    id: `codex-${label}`,
    isActive: false,
    displayName: label,
    label,
    providerDisplayName: label,
    providerAccountId: `codex-${label}-account`,
    credentialExpiresAt,
  });

  const row = (label: string) => cy.get(".provider-account-row").contains("strong", label)
    .closest(".provider-account-row");

  beforeEach(() => {
    const now = Date.now();
    const snapshot = {
      accounts: [
        // 창 안 — 이틀 뒤 만료.
        account("임박", now + DAY * 2),
        // 창 밖 — 나흘 뒤 만료.
        account("여유", now + DAY * 4),
        // 이미 지난 만료. 예고가 아니라 사실이라 이 자리에는 적지 않는다.
        account("만료됨", now - DAY),
        // 만료를 밝히지 않는 공급자.
        account("미상", null),
      ],
      providers: [providerState({ activeAccountId: null, observedActiveAccountId: null })],
      autoSwitchResume: false,
      autoSwitchPolicy: "registration",
      autoSwitchUsageGapPercent: null,
      resumeAccountPolicy: "activeAccount",
    };
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: snapshot });
    // 기동 직후의 일괄 사용량 갱신도 같은 스냅샷을 돌려줘야 등록 계정이 0건으로 덮이지 않는다.
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: snapshot });
    cy.visitApp();
    cy.openSettingsTab("connections");
  });

  it("사흘 창에 든 계정에만 남은 기간을 적는다", () => {
    row("임박").find(".provider-account-expiry").should("contain.text", "2일 뒤 만료");
    row("여유").find(".provider-account-expiry").should("not.exist");
    row("만료됨").find(".provider-account-expiry").should("not.exist");
    row("미상").find(".provider-account-expiry").should("not.exist");
  });
});
