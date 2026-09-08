// 하단 상태바의 계정별 사용량 미터는 계정 이름·창 눈금·도움말 문구를
// sidebarUsage.ts의 세 함수(sidebarAccountLabel/sidebarWindowMeter/sidebarMeterTitle)가 나눠
// 만든다(580cc4b). 세 함수의 조합은 단위 테스트가 보지만, 그 결과가 실제 화면의 이름·값·
// 진행바 aria·도움말에 그대로 붙는지는 아무 스펙도 보지 않았다. 계정이 빈 격리 백엔드의
// "미터 영역 자체가 없다"와, 계정 스냅샷을 세워 준 뒤의 등록/홈 계정·확인 불가·수치 없음
// 세 갈래를 한자리에서 본다.
//
// 상태바는 기본이 접힌 한 줄 요약(.statusbar-usages, 창 이름·수치만)이고, 맨 왼쪽 펴기
// 버튼을 누른 뒤에만 줄 위로 계정별 카드(.statusbar-details)가 열려 진행바가 그려진다. 선택은
// localStorage에 남아 다시 열어도 유지된다. 진행바 aria를 보는 시나리오는 저장값을 씨앗으로
// 심어 펼친 상태로 시작한다.
const STATUSBAR = ".app-statusbar";
const COMPACT_USAGES = ".statusbar-usages";
const DETAILS = ".statusbar-details";
const DENSITY_KEY = "agent-manager.statusbar-usage-density.v1";
const DENSITY_TOGGLE = ".statusbar-density";

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

function snapshot(providers, accounts = []) {
  return {
    accounts,
    providers,
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
  };
}

describe("좌측 메뉴 계정 사용량 미터", () => {
  beforeEach(() => {
    // 사이드바가 Antigravity 사용량을 따로 읽는다. 호스트 CLI가 탐지되는 하네스에서 실제
    // `/usage`를 띄우지 않도록 비어 있는 응답으로 막는다.
    cy.stubInvoke("get_antigravity_usage", { statusCode: 200, body: usage({ status: "idle", updatedAt: null }) });
  });

  it("계정이 없는 격리 백엔드에서는 미터 영역이 아예 없고 상태 상세는 플랫폼 표기로 남는다", () => {
    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.get(STATUSBAR).should("exist");
    // 계정도 홈 자격증명도 없으면 미터 목록 자체가 그려지지 않는다(빈 목록이 아니라 없음).
    cy.get(COMPACT_USAGES).should("not.exist");
    cy.get(DETAILS).should("not.exist");
    // 보여 줄 미터가 없으면 접기·펴기 버튼도 없다.
    cy.get(DENSITY_TOGGLE).should("not.exist");
    // 초기화 시각도 사용량 오류도 없으므로 상세 줄은 플랫폼·아키텍처로 떨어진다.
    cy.get(".statusbar-detail").invoke("text").should("match", /^\S+ · \S+$/);
  });

  it("기본은 접힌 요약이고 펴기 버튼을 누르면 진행바가 나타나며 선택이 다시 열어도 남는다", () => {
    const codex = account({
      usage: usage({ windows: [
        { label: "5시간", usedPercent: 36, resetsAt: null },
        { label: "7일", usedPercent: 79, resetsAt: null },
        // 모델별 창은 접힌 요약에서 빠지고 펼친 뒤에만 그려진다.
        { label: "GPT-6 7일", usedPercent: 10, resetsAt: null, modelScoped: true },
      ] }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: codex.id })], [codex]),
    });

    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.get(STATUSBAR).should("have.class", "compact");
    cy.get(DETAILS).should("not.exist");
    cy.get(`${COMPACT_USAGES} .statusbar-usage`).should("have.length", 1).as("meter");
    // 접힌 요약: 대표 창 두 개만 수치로, 진행바는 없다. 도움말에는 모델별 창까지 적힌다.
    cy.get("@meter").find(".statusbar-usage-pill").should("have.length", 2);
    cy.get("@meter").find(".statusbar-usage-value").then(($values) => {
      expect([...$values].map((node) => node.textContent)).to.deep.equal(["36%", "79%"]);
    });
    cy.get(`${STATUSBAR} .statusbar-progress`).should("not.exist");
    cy.get("@meter").find(".statusbar-usage-pill").eq(1).should("have.class", "warning");
    cy.get("@meter").invoke("attr", "title").should("match", / · 5시간 36% · 7일 79% · GPT-6 7일 10%$/);

    // 줄의 배치: 펴기 버튼이 맨 왼쪽, 새로고침이 맨 오른쪽이다.
    cy.get(".statusbar-line > :first-child").should("have.class", "statusbar-density");
    cy.get(".statusbar-line > :last-child").should("have.class", "statusbar-refresh");

    // 펴기 버튼은 상세 영역을 가리키고 상태를 밝힌다.
    cy.get(DENSITY_TOGGLE)
      .should("have.attr", "aria-expanded", "false")
      .and("have.attr", "aria-controls", "statusbar-usage-details")
      .and("have.attr", "aria-label", "사용량 상세정보 펴기")
      .click();
    cy.get(DENSITY_TOGGLE).should("have.attr", "aria-expanded", "true").and("have.attr", "aria-label", "사용량 상세정보 접기");
    cy.get(STATUSBAR).should("have.class", "detailed");
    // 펼치면 한 줄 요약은 사라지고 줄 위 카드에 모델별 창까지 진행바로 그려진다.
    cy.get(COMPACT_USAGES).should("not.exist");
    cy.get(DETAILS).should("have.attr", "id", "statusbar-usage-details");
    cy.get(`${DETAILS} .statusbar-usage-card`).should("have.length", 1).as("card");
    cy.get("@card").find(".statusbar-progress").should("have.length", 3);
    cy.get("@card").find(".statusbar-window-label").last().should("have.text", "GPT-6 7일");
    cy.window().then((win) => {
      expect(win.localStorage.getItem(DENSITY_KEY)).to.equal("detailed");
    });

    // 다시 열어도 펼친 상태가 남고, 접으면 요약으로 돌아간다.
    cy.reload();
    cy.view("dashboard").should("exist");
    cy.get(STATUSBAR).should("have.class", "detailed");
    cy.get(DENSITY_TOGGLE).click();
    cy.get(STATUSBAR).should("have.class", "compact");
    cy.get(`${STATUSBAR} .statusbar-progress`).should("not.exist");
    cy.get(COMPACT_USAGES).should("exist");
  });

  it("펼친 카드는 창 이름 옆에 초기화까지 남은 시간을 붙이고 시각이 없는 창에는 붙이지 않는다", () => {
    // 남은 시간은 그리는 순간의 시계로 재므로 분 경계에 걸리지 않도록 형식만 본다.
    const codex = account({
      usage: usage({ windows: [
        { label: "5시간", usedPercent: 36, resetsAt: Date.now() + 4 * 3_600_000 + 16 * 60_000 },
        { label: "7일", usedPercent: 79, resetsAt: Date.now() + 5 * 86_400_000 + 12 * 3_600_000 },
        { label: "초기화 시각 없음", usedPercent: 10, resetsAt: null },
      ] }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: codex.id })], [codex]),
    });

    cy.visitApp({ [DENSITY_KEY]: "detailed" });
    cy.view("dashboard").should("exist");
    cy.get(`${DETAILS} .statusbar-usage-card`).should("have.length", 1).as("card");

    // 남은 시간이 있는 창에만 칸이 생기고, 5시간 창은 시·분으로 7일 창은 일·시로 줄인다.
    cy.get("@card").find(".statusbar-window-reset").should("have.length", 2);
    cy.get("@card").find(".statusbar-window-reset").eq(0).invoke("text").should("match", /^\d+h \d+m$/);
    cy.get("@card").find(".statusbar-window-reset").eq(1).invoke("text").should("match", /^\d+d \d+h$/);

    // 초기화 시각이 없는 창은 이름과 수치만 남는다.
    cy.get("@card").find(".statusbar-usage-window").eq(2).find(".statusbar-window-reset").should("not.exist");
    cy.get("@card").find(".statusbar-usage-window").eq(2).find(".statusbar-window-label").should("have.text", "초기화 시각 없음");

    // 읽기 보조 기기에는 진행바 이름에 같은 값이 문장으로 붙는다.
    cy.get("@card").find(".statusbar-progress").eq(0)
      .invoke("attr", "aria-label").should("match", / · 5시간 36% · \d+h \d+m 뒤 초기화$/);
  });

  it("375px 화면의 긴 계정·창 문자열은 상태바 안에서만 스크롤되고 양끝 조작은 화면에 남는다", () => {
    const codex = account({
      displayName: "아주 긴 이름을 가진 기본 Codex 계정",
      usage: usage({ windows: [
        { label: "매우 긴 이름의 5시간 사용량 창", usedPercent: 36, resetsAt: null },
        { label: "매우 긴 이름의 7일 사용량 창", usedPercent: 79, resetsAt: null },
      ] }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: codex.id })], [codex]),
    });

    cy.viewport(375, 667);
    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.get(STATUSBAR).should("have.class", "compact");

    // 긴 내용은 가운데 요약 줄의 overflow-x로만 흘러야 한다. 페이지 전체나 상태바가
    // 뷰포트보다 넓어지면 모바일 원격 화면에서 양끝 조작을 잃는다.
    cy.document().then((doc) => {
      expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth);
      expect(doc.body.scrollWidth).to.be.at.most(doc.body.clientWidth);
    });
    cy.get(COMPACT_USAGES).then(($usages) => {
      expect($usages[0].scrollWidth).to.be.greaterThan($usages[0].clientWidth);
    });

    // 내부 내용이 넘쳐도 펴기·새로고침 버튼은 각각 화면 안에 남아 클릭할 수 있다.
    cy.get(DENSITY_TOGGLE).should("be.visible").then(($button) => {
      const rect = $button[0].getBoundingClientRect();
      expect(rect.left).to.be.at.least(0);
      expect(rect.right).to.be.at.most(375);
    });
    cy.get(".statusbar-refresh").should("be.visible").then(($button) => {
      const rect = $button[0].getBoundingClientRect();
      expect(rect.left).to.be.at.least(0);
      expect(rect.right).to.be.at.most(375);
    });
  });

  it("등록 계정과 홈 계정의 이름·눈금·진행바 aria가 도움말 문구와 같은 문자열을 쓴다", () => {
    const codex = account({
      usage: usage({ windows: [{ label: "5시간", usedPercent: 82.4, resetsAt: null }] }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([
        providerState({ activeAccountId: codex.id }),
        providerState({
          provider: "claude",
          home: {
            state: "verified",
            email: "home@example.com",
            displayName: "Home User",
            providerAccountId: "home-id",
            accountId: null,
            accessTokenExpiresAt: null,
            checkedAt: 1_700_000_000_000,
            retryAt: null,
            error: null,
            usage: usage({ windows: [{ label: "주간", usedPercent: 12.6, resetsAt: null }] }),
          },
        }),
      ], [codex]),
    });

    cy.visitApp({ [DENSITY_KEY]: "detailed" });
    cy.view("dashboard").should("exist");
    cy.get(`${DETAILS} .statusbar-usage-card`).should("have.length", 2);

    // 등록 기본 계정: 공급자 표시 이름 · 계정 이름. 홈 꼬리표는 붙지 않는다.
    cy.get(".statusbar-usage-card").first().as("codexMeter");
    cy.get("@codexMeter").find(".statusbar-usage-label").invoke("text").then((label) => {
      expect(label).to.match(/ · 기본 계정$/);
      expect(label).to.not.contain("(홈)");
      cy.get("@codexMeter").find(".statusbar-usage-value").should("have.text", "82%");
      // 진행바 aria 라벨은 계정 이름과 창 이름·표시값을 그대로 이어 붙인다.
      cy.get("@codexMeter").find(".statusbar-progress")
        .should("have.attr", "aria-label", `${label} · 5시간 82%`)
        .and("have.attr", "aria-valuenow", "82");
      // 도움말은 같은 계정 이름으로 시작하고 창별 값을 늘어놓는다. 갱신 실패 꼬리표는 없다.
      cy.get("@codexMeter").should("have.attr", "title", `${label} · 5시간 82%`);
    });
    // 70% 이상이면 경고 단계 색이 붙는다(설정 화면 미터와 같은 임계).
    cy.get("@codexMeter").find(".statusbar-usage-window").should("have.class", "warning");

    // 홈 계정은 등록 계정과 구분되게 (홈) 꼬리표를 단다.
    cy.get(".statusbar-usage-card").eq(1).as("homeMeter");
    cy.get("@homeMeter").find(".statusbar-usage-label")
      .should("contain.text", "home@example.com")
      .and("contain.text", "(홈)");
    cy.get("@homeMeter").find(".statusbar-usage-value").should("have.text", "13%");
    cy.get("@homeMeter").find(".statusbar-usage-window").should("not.have.class", "warning");
  });

  it("초기화가 지난 창의 재조회가 실패하면 0%가 아니라 확인 불가로 적고 도움말에 마지막 값 꼬리표가 붙는다", () => {
    const stale = account({
      displayName: "지난 계정",
      usage: usage({
        status: "error",
        error: "usage fetch failed",
        // resetsAt이 과거라 0%로 다듬어지지만, 재조회가 실패해 0%라고 단정할 수 없다.
        windows: [{ label: "5시간", usedPercent: 44, resetsAt: 1_600_000_000_000 }],
      }),
    });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: stale.id })], [stale]),
    });

    cy.visitApp({ [DENSITY_KEY]: "detailed" });
    cy.view("dashboard").should("exist");
    cy.get(`${DETAILS} .statusbar-usage-card`).should("have.length", 1).as("meter");
    cy.get("@meter").find(".statusbar-usage-value").should("have.text", "확인 불가");
    cy.get("@meter").find(".statusbar-usage-window").should("have.class", "unavailable");
    // 확인 불가면 수치를 단정하지 않으므로 aria-valuenow를 달지 않는다.
    cy.get("@meter").find(".statusbar-progress").should("not.have.attr", "aria-valuenow");
    cy.get("@meter").invoke("attr", "title").should("match", /확인 불가 · 갱신 실패로 마지막 조회 값$/);
    // 마지막 성공 수치가 남아 있으면 조회 실패를 상세 줄로 알리지 않는다(sidebarUsage.ts:187).
    cy.get(".statusbar-detail").should("not.have.text", "사용량 확인 오류");
  });

  it("보여 줄 창이 하나도 없으면 값 자리에 오류를 적고 창 이름은 사용량 정보 없음이 된다", () => {
    const blank = account({ displayName: "빈 계정", usage: usage({ status: "error", error: "no windows" }) });
    cy.stubInvoke("get_provider_accounts", {
      statusCode: 200,
      body: snapshot([providerState({ activeAccountId: blank.id })], [blank]),
    });

    cy.visitApp({ [DENSITY_KEY]: "detailed" });
    cy.view("dashboard").should("exist");
    cy.get(`${DETAILS} .statusbar-usage-card`).should("have.length", 1).as("meter");
    cy.get("@meter").find(".statusbar-window-label").should("have.text", "사용량 정보 없음");
    cy.get("@meter").find(".statusbar-usage-value").should("have.text", "오류");
    cy.get("@meter").invoke("attr", "title").should("match", /빈 계정 · 사용량 정보 없음$/);
    // 보여 줄 값이 아예 없을 때만 상태 상세 줄이 오류 안내로 바뀐다.
    cy.get(".statusbar-detail").should("have.text", "사용량 확인 오류");
  });
});
