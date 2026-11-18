import { providerAccount, providerState } from "../support/providerAccountFixtures";

// 2026-09-18 QA(축: 워크플로·반복요청) — 반복 요청 편집기는 2026-09-17부터 실행 계정을
// 물을지 말지를 화면에 적힌 공급자 목록이 아니라 계정 스냅숏의 providers 자리로 판정한다
// (`src/components/ChatSchedules.tsx:518`, `fd959505`). 그 판정에는 갈래가 둘 더 있는데
// 어느 스펙도 밟지 않았다. 스냅숏이 아직 오지 않았으면(조회 실패·지연) "묻는 쪽"으로 두고,
// 스냅숏에 그 공급자 자리가 없으면 계정을 아예 묻지 않는다. 같은 값이 실행 계정 필드,
// "사용 가능한 계정이 없습니다" 배너, 저장 버튼 활성까지 세 곳을 한꺼번에 움직이므로
// (같은 파일 588줄) 세 곳이 함께 움직이는지 본다.
//
// 기존 `am20260918-antigravity-schedule-account.cy.ts`는 스냅숏이 정상 도착하고 계정이
// 여럿 있는 경우만 다뤘다. 이 스펙은 그 반대편 두 경계다.

const claudeAccount = providerAccount({
  id: "claude-gate-qa",
  provider: "claude",
  displayName: "Claude 게이트 QA",
  providerAccountId: "claude-gate-provider-id",
  providerDisplayName: "Claude 게이트 QA",
  authStatus: "ready",
});

// Antigravity 자리가 빠진 스냅숏. 계정 레지스트리가 아직 그 공급자를 담지 않던 시절의
// 응답 모양이며, 이때 화면은 계정을 묻지 않아야 한다.
const claudeOnlySnapshot = {
  accounts: [claudeAccount],
  providers: [providerState({
    provider: "claude",
    activeAccountId: claudeAccount.id,
    observedActiveAccountId: claudeAccount.id,
  })],
  autoSwitchResume: false,
  autoSwitchPolicy: "registration",
  autoSwitchUsageGapPercent: null,
  resumeAccountPolicy: "activeAccount",
};

function detectAllProviders() {
  cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      const body = res.body as { status: { providers: Array<{ provider: string; cli: { detected: boolean } }> } };
      for (const provider of body.status.providers) provider.cli.detected = true;
    });
  });
}

function field(label: string) {
  return cy.get(".schedule-editor").contains("label > span", new RegExp(`^${label}$`)).parent();
}

const accountField = () => cy.get(".schedule-editor").contains("label > span", /^실행 계정$/);
const noAccountBanner = () => cy.get(".schedule-editor").contains("선택한 공급자에 사용 가능한 계정이 없습니다");
const submit = () => cy.get('.schedule-editor footer button[type="submit"]');

describe("2026-09-18 · 반복 요청 편집기의 실행 계정 필드가 계정 스냅숏 도착 여부를 따른다", () => {
  it("스냅숏이 오지 않으면 계정을 묻고, 고른 계정이 없어 저장을 막는다", () => {
    detectAllProviders();
    // 폴링·일괄 갱신 두 경로를 모두 실패시켜야 accounts가 null로 남는다. 한쪽만 막으면
    // 다른 쪽 응답이 스냅숏을 채워 이 경계가 사라진다.
    cy.stubInvoke("get_provider_accounts", { statusCode: 500, body: { error: "격리 QA: 계정 스냅숏 지연" } });
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 500, body: { error: "격리 QA: 계정 스냅숏 지연" } });

    cy.visitApp();
    cy.openScheduleEditor();

    // 묻는 쪽으로 둔다 — 필드가 있고, 고를 계정이 없다는 안내까지 함께 뜬다.
    accountField().should("exist");
    // 고른 계정이 없으므로 아무 항목도 선택되지 않는다(자리지기 항목이 disabled라
    // selectedIndex가 -1이고 val()은 null이다). 계정 목록이 없으니 "실행 시점 기본 계정"에는
    // 지금 계정 이름이 붙지 않는다.
    field("실행 계정").find("select").should(($select) => {
      expect($select.val() ?? "").to.equal("");
    }).within(() => {
      cy.get('option[value="__active__"]').should("have.text", "실행 시점 활성 계정");
    });
    // 배너는 편집기 아래쪽 스크롤 영역에 있어 처음에는 잘려 있다. 굴려서 실제로 보이는지까지 본다.
    noAccountBanner().scrollIntoView().should("be.visible");

    // 나머지 필수 입력을 다 채워도 계정이 비어 저장이 막혀 있어야 한다.
    field("반복할 요청").find("textarea").type("스냅숏 미도착 경계 확인");
    field("작업 경로").find("input").clear().type("/tmp/am-schedule-account-gate");
    submit().should("be.disabled");

    // 실행 시점 기본 계정을 고르면 그때부터 저장할 수 있다.
    field("실행 계정").find("select").select("__active__");
    submit().should("not.be.disabled");
  });

  it("스냅숏에 그 공급자 자리가 없으면 계정을 묻지 않고 저장을 막지도 않는다", () => {
    detectAllProviders();
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: claudeOnlySnapshot });
    cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: claudeOnlySnapshot });
    cy.stubInvoke("create_scheduled_request", { statusCode: 200, body: null }).as("createSchedule");

    cy.visitApp();
    cy.openScheduleEditor();

    // 자리가 있는 Claude는 그대로 묻는다.
    field("공급자").find("select").select("claude");
    accountField().should("exist");
    noAccountBanner().should("not.exist");

    // 자리가 빠진 Antigravity로 바꾸면 필드와 배너가 함께 사라진다.
    field("공급자").find("select").select("antigravity");
    accountField().should("not.exist");
    noAccountBanner().should("not.exist");

    field("반복할 요청").find("textarea").type("공급자 자리 없는 스냅숏 경계 확인");
    field("작업 경로").find("input").clear().type("/tmp/am-schedule-account-gate");
    cy.get(".schedule-editor").contains("label", "저장 후 활성화").find("input").uncheck();
    submit().should("not.be.disabled").click();

    // 계정을 묻지 않았으므로 저장 봉투에도 고정 계정이 실리지 않는다(빈 문자열이 "고정 없음").
    cy.wait("@createSchedule").its("request.body.request").should((request) => {
      expect(request).to.include({
        source: "antigravity",
        cwd: "/tmp/am-schedule-account-gate",
        enabled: false,
        accountId: "",
        useActiveAccount: false,
      });
    });
    cy.get(".schedule-editor").should("not.exist");
  });
});
