// 반복 요청 편집기를 "다른 대상으로 옮겨 열 때" 앞 대상의 초안이 남지 않는지 본다.
//
// 편집기는 저장본을 useState 초기값으로만 읽는다(src/components/ChatSchedules.tsx:439 이후,
// 주기·활성 창은 2026-09-13 리팩토링으로 useScheduleRecurrenceDraft·useScheduleActiveWindowDraft
// 두 훅으로 옮겨졌다 — 27607bb1). 초기값은 마운트 때 한 번만 읽히므로, 목록이 편집기를
// 다시 쓰는 순간(다른 요청의 '수정', 또는 '새 반복 요청') 컴포넌트가 새로 마운트되지 않으면
// 앞 대상에서 치던 값이 그대로 남아 다른 요청 위에 덮여 저장된다. 목록은 그것을 막으려고
// key를 걸어 둔다(ChatSchedules.tsx:192).
//
// 기존 스펙은 모두 '새 반복 요청'으로만 편집기를 열었고(schedule-editor-target-switch,
// schedule-frequency-fields, schedule-session-read-policy, qa49-active-window-inverted),
// 저장본을 불러 여는 '수정' 경로와 편집 대상 간 전환은 어느 스펙도 잡은 적이 없다.
// 격리 백엔드에는 반복 요청이 없으므로 목록 스냅샷과 상세 조회를 스텁으로 세운다.

const morning = {
  id: "schedule-qa-morning",
  name: "아침 회차 정리",
  prompt: "아침에 회차 상태를 정리해줘",
  source: "claude",
  accountId: "",
  useActiveAccount: true,
  cwd: "/tmp/am-qa-morning",
  model: null,
  reasoningEffort: null,
  mode: "workspace",
  approvalMode: "never",
  recurrence: { frequency: "daily", interval: 1, hour: 7, minute: 5, weekday: 1, cron: null, timezone: "Asia/Seoul" },
  sessionStrategy: "newChat",
  resumeFailurePolicy: "retryThenNewChat",
  providerSessionId: null,
  enabled: true,
  workflow: null,
  activeFrom: null,
  activeUntil: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  nextRunAt: 1_700_100_000_000,
  lastRunAt: null,
  manualRunRequestedAt: null,
};

const night = {
  ...morning,
  id: "schedule-qa-night",
  name: "야간 로그 점검",
  prompt: "밤마다 로그를 점검해줘",
  cwd: "/tmp/am-qa-night",
  recurrence: { frequency: "hourly", interval: 6, hour: 22, minute: 30, weekday: 3, cron: null, timezone: "Asia/Seoul" },
  sessionStrategy: "continue",
};

const details: Record<string, unknown> = { [morning.id]: morning, [night.id]: night };

function editor() {
  return cy.get(".schedule-editor");
}

// 라벨 텍스트는 <span>에 실린다. label 전체를 contains로 잡으면 셀렉트의 옵션 문구까지 걸린다.
function field(label: string) {
  return editor().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function openEdit(name: string) {
  cy.contains(".schedule-card", name).contains("footer .button", "수정").click();
  return cy.get(".schedule-editor").should("be.visible");
}

describe("반복 요청 편집기 · 편집 대상 전환과 초안 격리", () => {
  beforeEach(() => {
    cy.stubInvoke("get_scheduler_snapshot", {
      statusCode: 200,
      body: { paused: false, runnerActive: true, schedules: [morning, night], runs: [] },
    });
    cy.stubInvoke("get_scheduled_request_detail", (req) => {
      const id = (req.body as { id?: string } | undefined)?.id ?? "";
      req.reply({ statusCode: 200, body: details[id] ?? morning });
    });
    cy.visitApp();
    cy.openView("chat");
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    cy.get(".schedule-card").should("have.length", 2);
  });

  it("저장본을 '수정'으로 열면 이름·요청·경로·주기가 그 요청의 값으로 채워진다", () => {
    openEdit("아침 회차 정리");
    editor().find("header strong").should("have.text", "반복 요청 수정");
    editor().find("header span").should("have.text", "Asia/Seoul");
    field("이름").find("input").should("have.value", "아침 회차 정리");
    field("반복할 요청").find("textarea").should("have.value", "아침에 회차 상태를 정리해줘");
    field("작업 경로").find("input").should("have.value", "/tmp/am-qa-morning");
    field("주기").find("select").should("have.value", "daily");
    editor().find('input[type="number"][max="23"]').should("have.value", "7");
    editor().find('input[type="number"][max="59"]').should("have.value", "5");
    field("세션 방식").find("select").should("have.value", "newChat");
  });

  it("고친 초안을 두고 다른 요청의 '수정'을 누르면 그 요청의 저장본으로 갈리고 앞 초안이 넘어오지 않는다", () => {
    openEdit("아침 회차 정리");
    field("이름").find("input").clear().type("초안만 고친 이름");
    field("반복할 요청").find("textarea").clear().type("저장하지 않은 요청 본문");
    field("주기").find("select").select("cron");
    field("Cron · 분 시 일 월 요일").find("input").clear().type("0 3 * * *");

    openEdit("야간 로그 점검");
    field("이름").find("input").should("have.value", "야간 로그 점검");
    field("반복할 요청").find("textarea").should("have.value", "밤마다 로그를 점검해줘");
    field("작업 경로").find("input").should("have.value", "/tmp/am-qa-night");
    // 주기 묶음도 저장본을 다시 읽어야 한다 — cron 초안이 남으면 간격 칸이 서지 않는다.
    field("주기").find("select").should("have.value", "hourly");
    field("간격").find("input").should("have.value", "6");
    editor().find('input[type="text"][placeholder="0 9 * * 1-5"]').should("not.exist");
    field("세션 방식").find("select").should("have.value", "continue");
  });

  it("수정 중에 '새 반복 요청'을 누르면 빈 새 편집기가 서고 고치던 값이 남지 않는다", () => {
    openEdit("야간 로그 점검");
    field("이름").find("input").clear().type("남으면 안 되는 이름");

    cy.newScheduleEditor();
    editor().find("header strong").should("have.text", "새 반복 요청");
    field("이름").find("input").should("have.value", "");
    field("반복할 요청").find("textarea").should("have.value", "");
    field("주기").find("select").should("have.value", "daily");
    editor().find('input[type="number"][max="23"]').should("have.value", "9");
    editor().find('input[type="number"][max="59"]').should("have.value", "0");
  });

  it("취소로 닫은 수정 초안은 같은 요청을 다시 열 때 저장본으로 돌아온다", () => {
    openEdit("아침 회차 정리");
    field("이름").find("input").clear().type("취소될 이름");
    editor().contains("footer .button", "취소").click();
    cy.get(".schedule-editor").should("not.exist");

    openEdit("아침 회차 정리");
    field("이름").find("input").should("have.value", "아침 회차 정리");
  });
});
