/// <reference types="cypress" />
// 사이드바에서 하단 셸 footer로 분리된 상태바(.app-statusbar, 8fa8a23)의
// 접근성(a11y) 계약과 다국어 전환을 본다.
//
// 상태바는 다음 조작 요소와 접근성 속성을 갖는다:
// 1) footer.app-statusbar: aria-label="CLI 연결과 사용량 상태바"
// 2) "n/3 CLI 연결" 버튼(.statusbar-open)은 걷어냈다 — 상태바에 남아 있지 않아야 한다.
// 3) .statusbar-refresh:
//    - aria-label="CLI 연결과 사용량 새로고침" / title="CLI 연결과 사용량 새로고침"
// 4) 계정 사용량이 있을 때 나타나는 펴기/접기 버튼(.statusbar-density):
//    - 접힘(기본): aria-expanded="false", aria-label="사용량 상세정보 펴기"
//    - 펼침(detailed): aria-expanded="true", aria-label="사용량 상세정보 접기"
// 5) 언어를 영어(en)로 전환했을 때:
//    - 상태바 aria-label: "CLI connection and usage status bar"
//    - statusbar-refresh: "Refresh CLI connections and usage"
//    - statusbar-density: "Expand usage details" / "Collapse usage details"

const STATUSBAR = ".app-statusbar";
const DENSITY_KEY = "agent-manager.statusbar-usage-density.v1";

function usage(overrides = {}) {
  return { status: "ok", windows: [], updatedAt: 1_700_000_000_000, error: null, ...overrides };
}

function account(overrides = {}) {
  return {
    id: "codex-1",
    provider: "codex",
    displayName: "기본 계정",
    email: null,
    organization: null,
    providerAccountId: "codex-acc",
    label: null,
    providerDisplayName: "기본 계정",
    isActive: true,
    disabled: false,
    autoSwitch: false,
    autoSwitchPriority: null,
    authStatus: "ok",
    usage: usage({ windows: [{ label: "5시간", usedPercent: 40, resetsAt: null }] }),
    note: null,
    credentialIsolated: true,
    credentialIsolationNote: null,
    runtimeCount: 0,
    ...overrides,
  };
}

function providerState(overrides = {}) {
  return {
    provider: "codex",
    activeAccountId: null,
    observedActiveAccountId: null,
    runtimeCount: 0,
    lastAutoSwitch: null,
    home: {
      state: "absent",
      email: null,
      displayName: null,
      providerAccountId: null,
      accountId: null,
      accessTokenExpiresAt: null,
      checkedAt: null,
      retryAt: null,
      error: null,
      usage: usage(),
    },
    ...overrides,
  };
}

function snapshot(providers: any[], accounts: any[] = []) {
  return {
    accounts,
    providers,
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
  };
}

describe("하단 상태바 접근성 이름과 영어 전환 다국어 계약", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("한국어 UI에서 상태바 랜드마크 및 버튼들의 접근성 이름과 툴팁이 올바르고 CLI 연결 수 버튼은 없다", () => {
    cy.visitApp();
    cy.view("dashboard").should("exist");

    // 1) 상태바 루트 접근성 이름
    cy.get(STATUSBAR)
      .should("have.attr", "aria-label", "CLI 연결과 사용량 상태바");

    // 2) 걷어낸 CLI 연결 수 버튼은 어떤 형태로도 남지 않는다
    cy.get(".statusbar-open").should("not.exist");
    cy.get(STATUSBAR).invoke("text").should("not.match", /\d\/3/);

    // 3) 새로고침 버튼 접근성 이름과 툴팁
    cy.get(".statusbar-refresh")
      .should("have.attr", "aria-label", "CLI 연결과 사용량 새로고침")
      .and("have.attr", "title", "CLI 연결과 사용량 새로고침");
  });

  it("사용량이 있는 경우 펴기/접기 버튼의 aria-expanded 및 접근성 이름이 상태에 따라 토글된다", () => {
    const codex = account();
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: codex.id })], [codex]),
    });

    cy.visitApp();
    cy.view("dashboard").should("exist");

    // 기본(접힘): aria-expanded false 및 펴기 문구
    cy.get(".statusbar-density")
      .should("be.visible")
      .and("have.attr", "aria-expanded", "false")
      .and("have.attr", "aria-controls", "statusbar-usage-details")
      .and("have.attr", "aria-label", "사용량 상세정보 펴기")
      .and("have.attr", "title", "사용량 상세정보 펴기");

    // 클릭 시 펼침: aria-expanded true 및 접기 문구
    cy.get(".statusbar-density").click();
    cy.get(".statusbar-density")
      .should("have.attr", "aria-expanded", "true")
      .and("have.attr", "aria-label", "사용량 상세정보 접기")
      .and("have.attr", "title", "사용량 상세정보 접기");
  });

  it("영어 UI로 전환 시 상태바 및 버튼들의 접근성 이름과 표시 텍스트가 영어로 번역된다", () => {
    const codex = account();
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: codex.id })], [codex]),
    });

    cy.visitApp({ [DENSITY_KEY]: "compact" });
    cy.setLanguage("en");

    // 1) 상태바 루트
    cy.get(STATUSBAR)
      .should("have.attr", "aria-label", "CLI connection and usage status bar");

    // 2) 새로고침 버튼
    cy.get(".statusbar-refresh")
      .should("have.attr", "aria-label", "Refresh CLI connections and usage")
      .and("have.attr", "title", "Refresh CLI connections and usage");

    // 3) 밀도 토글 버튼 (접힘 상태)
    cy.get(".statusbar-density")
      .should("have.attr", "aria-label", "Expand usage details")
      .and("have.attr", "title", "Expand usage details")
      .click();

    // 4) 밀도 토글 버튼 (펼침 상태)
    cy.get(".statusbar-density")
      .should("have.attr", "aria-label", "Collapse usage details")
      .and("have.attr", "title", "Collapse usage details");
  });
});
