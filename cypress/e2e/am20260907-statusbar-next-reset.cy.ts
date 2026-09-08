/// <reference types="cypress" />
// 하단 상태바(AppStatusbar, 200ae9f)의 상세 줄은 세 갈래 중 하나를 적는다:
// 사용량 확인 오류 > 다음 초기화 시각 > 플랫폼·아키텍처. 기존 스펙은 오류 갈래와
// 플랫폼 갈래만 봤고, nearestUsageReset이 고르는 "가장 이른 미래 초기화" 갈래와
// 오류가 초기화 시각을 이기는 우선순위는 어느 스펙도 보지 않았다.
const STATUSBAR = ".app-statusbar";
const DETAIL = ".statusbar-detail";
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
    usage: usage(),
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

const HOUR = 3_600_000;

describe("상태바 상세 줄의 다음 초기화 시각 갈래", () => {
  beforeEach(() => {
    cy.stubInvoke("get_antigravity_usage", { statusCode: 200, body: usage({ status: "idle", updatedAt: null }) });
  });

  after(() => {
    cy.restoreLanguage();
  });

  it("여러 계정·창의 초기화 시각 중 아직 오지 않은 가장 이른 시각을 적는다", () => {
    const soon = Date.now() + 2 * HOUR;
    const later = Date.now() + 30 * HOUR;
    const past = Date.now() - 5 * HOUR;
    const codex = account({
      usage: usage({ windows: [
        { label: "7일", usedPercent: 20, resetsAt: later },
        // 이미 지난 시각은 다음 초기화가 아니므로 후보에서 빠진다.
        { label: "5시간", usedPercent: 10, resetsAt: past },
      ] }),
    });
    const claude = account({
      id: "claude-1",
      provider: "claude",
      displayName: "클로드 계정",
      providerAccountId: "claude-acc",
      usage: usage({ windows: [{ label: "주간", usedPercent: 30, resetsAt: soon }] }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([
        providerState({ activeAccountId: codex.id }),
        providerState({ provider: "claude", activeAccountId: claude.id }),
      ], [codex, claude]),
    });

    cy.visitApp({ [DENSITY_KEY]: "compact" });
    cy.view("dashboard").should("exist");
    cy.get(STATUSBAR).should("exist");
    cy.get(DETAIL).invoke("text").then((detail) => {
      expect(detail).to.equal(`${new Date(soon).toLocaleString()} 초기화`);
      // 초기화 시각이 있으면 플랫폼·아키텍처 갈래로 떨어지지 않는다.
      expect(detail).to.not.match(/^\S+ · \S+$/);
    });

    // 영어로 전환하면 접미사만 reset으로 바뀐다.
    cy.setLanguage("en");
    cy.get(DETAIL).invoke("text").should("equal", `${new Date(soon).toLocaleString()} reset`);
    // qa48: UI 언어는 백엔드 설정에 남아 다음 케이스까지 이어진다. 세 번째 케이스가 한국어
    // "사용량 확인 오류"를 찾으므로, 영어 전환은 이 케이스 안에서 되돌리고 끝낸다.
    cy.restoreLanguage();
  });

  it("미래 초기화 시각이 하나도 없으면 플랫폼·아키텍처 갈래로 떨어진다", () => {
    const codex = account({
      usage: usage({ windows: [{ label: "5시간", usedPercent: 10, resetsAt: Date.now() - HOUR }] }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: codex.id })], [codex]),
    });

    cy.visitApp({ [DENSITY_KEY]: "compact" });
    cy.view("dashboard").should("exist");
    cy.get(DETAIL).invoke("text").should("match", /^\S+ · \S+$/);
  });

  it("보여 줄 값이 없는 오류 계정이 섞이면 미래 초기화 시각보다 오류 문구가 앞선다", () => {
    const soon = Date.now() + 2 * HOUR;
    const healthy = account({
      usage: usage({ windows: [{ label: "5시간", usedPercent: 20, resetsAt: soon }] }),
    });
    const broken = account({
      id: "claude-1",
      provider: "claude",
      displayName: "빈 계정",
      providerAccountId: "claude-acc",
      usage: usage({ status: "error", error: "no windows" }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([
        providerState({ activeAccountId: healthy.id }),
        providerState({ provider: "claude", activeAccountId: broken.id }),
      ], [healthy, broken]),
    });

    cy.visitApp({ [DENSITY_KEY]: "compact" });
    cy.view("dashboard").should("exist");
    cy.get(DETAIL).should("have.text", "사용량 확인 오류");
  });
});
