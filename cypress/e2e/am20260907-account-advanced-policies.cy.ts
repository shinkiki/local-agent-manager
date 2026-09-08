/**
 * 연결 탭 계정 고급 설정 4종(SettingsView.tsx:1213~1275)의 저장과 복원.
 *
 * 기존 계정 스펙은 계정 0건 안내와 CLI 탐지 표시(am27-accounts-empty), 계정 풀 모달
 * (am20260907-usage-budget-pool-modal)까지만 본다. 계정 목록 아래에 붙은 고급 설정
 * 네 자리 — 한도 페일오버 방식·사용량 분산 교체·이어가기 실행 계정·자동전환 후
 * 세션 복원 — 는 어느 스펙도 만지지 않는다. 이 네 자리는 계정이 0건이어도 조작할 수
 * 있고(`disabled={!canManage || !accounts}`) 저장은 계정 스냅샷을 통째로 되받는
 * 경로를 타므로, 네 개를 한 번에 바꿨을 때 서로를 덮지 않는지와 화면을 떠났다
 * 돌아왔을 때·앱을 다시 띄웠을 때 남는지를 본다.
 */
const POLICY = ".account-auto-switch-policy";

function openConnections() {
  cy.anchor("nav.settings").click();
  cy.anchor("settings.tab.connections").click();
  cy.anchor("settings.connections").should("be.visible");
}

function select(label: string) {
  return cy.get(`${POLICY}[aria-label="${label}"]`);
}

/** 네 자리의 기대값을 한 번에 확인한다. */
function expectPolicies(failover: string, gap: string, resume: string, resumeOn: boolean) {
  select("한도 페일오버 방식").should("have.value", failover);
  select("사용량 분산 교체").should("have.value", gap);
  select("이어가기 실행 계정").should("have.value", resume);
  cy.get(".account-advanced-toggle .app-toggle").should("have.attr", "aria-checked", String(resumeOn));
}

describe("계정 고급 설정 4종의 저장과 복원", () => {
  it("계정 0건에서도 네 자리를 각각 바꿀 수 있고, 화면 왕복과 재기동 뒤에도 남는다", () => {
    cy.visitApp();
    openConnections();

    // 초기값 — 기본값 네 벌. 여기서 출발해야 바뀜을 판정할 수 있다.
    expectPolicies("maxHeadroom", "", "activeAccount", true);

    // 1) 네 자리를 차례로 바꾼다. 각 저장은 계정 스냅샷을 되받으므로 앞서 바꾼 값이
    //    되감기면 여기서 드러난다.
    select("한도 페일오버 방식").select("priority").should("have.value", "priority");
    select("사용량 분산 교체").find("option").eq(1).then(($option) => {
      const gap = $option.val() as string;
      select("사용량 분산 교체").select(gap).should("have.value", gap);
      select("이어가기 실행 계정").select("lastUsedAccount").should("have.value", "lastUsedAccount");
      cy.get(".account-advanced-toggle .app-toggle").click();

      expectPolicies("priority", gap, "lastUsedAccount", false);
      cy.get(".error-banner").should("not.exist");

      // 2) 다른 화면을 들렀다 돌아온다 — 컴포넌트가 다시 마운트되며 스냅샷을 새로 읽는다.
      cy.anchor("nav.sessions").click();
      openConnections();
      expectPolicies("priority", gap, "lastUsedAccount", false);

      // 3) 앱을 다시 띄운다 — 백엔드에 실제로 저장됐는지는 이것으로만 갈린다.
      cy.visitApp();
      openConnections();
      expectPolicies("priority", gap, "lastUsedAccount", false);
    });
  });
});
