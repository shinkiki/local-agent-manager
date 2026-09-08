// QA #49 회귀: 반복 요청 편집기는 역전된 활성 창(종료 <= 시작)을 입력 시점에 알린다.
// 백엔드(scheduler.rs)가 거절하는 문장과 같은 문장을 고급 옵션의 칸 옆에 두고, 고급 옵션 요약에
// "활성 창 역전"을 적고, 저장 버튼을 막는다. 예전에는 저장을 눌러야만 같은 문장을 볼 수 있었다.
//
// 저장 버튼을 보려면 저장 조건이 채워져야 한다. 격리 백엔드에는 계정이 없어 채팅 대상 저장이 늘
// 막혀 있으므로, 계정 스냅샷에 준비된 Claude 계정 하나를 덧대 조건을 채운다(다른 조건과 겹치지
// 않게 하려는 것이지 계정 화면을 시험하는 것이 아니다).

const INVERTED = "활성 종료 일시는 활성 시작 일시보다 뒤여야 합니다.";

function usage() {
  return { status: "ok", windows: [], updatedAt: 1_700_000_000_000, error: null };
}

function claudeAccount() {
  return {
    id: "claude-qa49",
    provider: "claude",
    displayName: "QA 계정",
    email: null,
    organization: null,
    providerAccountId: "claude-qa49-acc",
    label: null,
    providerDisplayName: "QA 계정",
    isActive: true,
    disabled: false,
    autoSwitch: false,
    autoSwitchPriority: null,
    authStatus: "ready",
    usage: usage(),
    note: null,
    credentialIsolated: true,
    credentialIsolationNote: null,
    runtimeCount: 0,
  };
}

function accountSnapshot() {
  return {
    accounts: [claudeAccount()],
    providers: [{
      provider: "claude",
      activeAccountId: "claude-qa49",
      observedActiveAccountId: null,
      runtimeCount: 0,
      lastAutoSwitch: null,
      home: { state: "absent", email: null, displayName: null, providerAccountId: null, accountId: null, accessTokenExpiresAt: null, checkedAt: null, retryAt: null, error: null, usage: usage() },
    }],
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
  };
}

function editor() {
  return cy.get(".schedule-editor");
}

function field(label: string) {
  return editor().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function saveButton() {
  return editor().find('footer button[type="submit"]');
}

function invalidNote() {
  return editor().find(".schedule-advanced-window .schedule-window-invalid");
}

describe("반복 요청 편집기의 역전된 활성 창 안내", () => {
  beforeEach(() => {
    cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: accountSnapshot() });
    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("종료가 시작보다 앞이면 칸 옆과 요약에 이유가 뜨고 저장이 막히며, 고치면 풀린다", () => {
    field("공급자").find("select").select("claude");
    field("반복할 요청").find("textarea").type("QA 활성 창 검증");
    field("작업 경로").find("input").clear().type("/tmp/qa49");
    // 계정·요청·경로가 채워져 저장은 열려 있다 — 아래의 비활성은 활성 창 때문임을 가린다.
    saveButton().should("not.be.disabled");

    editor().find(".schedule-advanced-toggle").click();
    editor().find(".schedule-advanced-toggle small").should("contain.text", "활성 창 제한 없음");
    field("활성 시작").find("input").type("2026-09-10T10:00");
    field("활성 종료").find("input").type("2026-09-09T10:00");

    // 1) 칸 옆: 백엔드가 거절하는 문장과 같은 문장이 곧바로 뜬다(저장을 누르지 않았다).
    invalidNote().should("have.attr", "role", "alert").and("contain.text", INVERTED);
    field("활성 종료").find("input").should("have.attr", "aria-invalid", "true");
    // 2) 요약: 고급 옵션을 접어도 이유를 알 수 있게 요약 줄이 역전을 말한다.
    editor().find(".schedule-advanced-toggle small").should("contain.text", "활성 창 역전");
    // 3) 저장은 막힌다.
    saveButton().should("be.disabled");

    // 같은 시각도 역전이다(종료 <= 시작).
    field("활성 종료").find("input").clear().type("2026-09-10T10:00");
    invalidNote().should("exist");
    saveButton().should("be.disabled");

    // 종료를 시작 뒤로 고치면 안내가 사라지고 요약이 창 범위로 돌아오며 저장이 다시 열린다.
    field("활성 종료").find("input").clear().type("2026-09-11T10:00");
    invalidNote().should("not.exist");
    field("활성 종료").find("input").should("not.have.attr", "aria-invalid");
    editor().find(".schedule-advanced-toggle small").should("contain.text", "활성 창 ").and("not.contain.text", "역전");
    saveButton().should("not.be.disabled");
  });
});
