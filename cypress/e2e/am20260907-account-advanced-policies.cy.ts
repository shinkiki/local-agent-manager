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
  cy.openSettingsTab("connections");
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
    // 조작 전의 오류 배너. 이 화면에는 계정 카드 하나가 여러 사유의 오류를 함께 쓰는
    // 자리가 있어, 조작이 만든 오류인지는 "전후 비교"로만 가릴 수 있다.
    let bannersBefore = "";
    cy.get("body").then(($body) => { bannersBefore = $body.find(".error-banner").text(); });

    // 1) 네 자리를 차례로 바꾼다. 각 저장은 계정 스냅샷을 되받으므로 앞서 바꾼 값이
    //    되감기면 여기서 드러난다.
    select("한도 페일오버 방식").select("priority").should("have.value", "priority");
    select("사용량 분산 교체").find("option").eq(1).then(($option) => {
      const gap = $option.val() as string;
      select("사용량 분산 교체").select(gap).should("have.value", gap);
      select("이어가기 실행 계정").select("lastUsedAccount").should("have.value", "lastUsedAccount");
      cy.get(".account-advanced-toggle .app-toggle").click();

      expectPolicies("priority", gap, "lastUsedAccount", false);
      // 저장이 실패하지 않았는지만 본다. 계정 카드의 오류 배너는 자리가 하나라 이 조작과
      // 무관한 오류도 같은 곳에 뜬다 — 하네스는 HOME만 격리하고 CLI는 호스트 PATH에서
      // 찾으므로, agy가 깔린 기계에서는 "Antigravity CLI가 로그인되어 있지 않습니다"가
      // 탭을 여는 것만으로 이미 떠 있다. 그래서 "없다"가 아니라 "늘지 않았다"를 본다.
      cy.get("body").then(($body) => {
        expect($body.find(".error-banner").text()).to.eq(bannersBefore);
      });

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
