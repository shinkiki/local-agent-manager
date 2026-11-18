// 반복 요청 편집기의 '실행 대상'(에이전트 요청 ↔ 시스템 워크플로) 전환 계약을 붙잡는다.
// 두 대상은 같은 폼 안에서 필드 묶음을 통째로 갈아끼우고(src/components/ChatSchedules.tsx:386)
// 저장 버튼의 비활성 조건도 대상마다 다른 식을 쓴다. 상태는 한 컴포넌트에 함께 살아 있으므로
// 대상을 오갔다 돌아오면 채워 둔 채팅 전용 입력이 남아야 하고, 반대로 워크플로 대상에서는
// 채팅 전용 안내(계정 없음 배너·고급 옵션의 세션 참조 요약)가 사라져야 한다.
// - 대상 상태: ChatSchedules.tsx:266, 조건부 필드: ChatSchedules.tsx:386
// - 계정 없음 배너: target === "chat" && managesAccounts && providerAccounts.length === 0
// - 워크플로 없음 안내: workflows.length === 0
// - 저장 비활성 식: target === "workflow" ? !workflowId : (managesAccounts && !accountId) || !prompt.trim() || !cwd.trim()
// 격리 하네스는 계정도 워크플로도 비어 있어 양쪽 빈 상태를 한 화면에서 볼 수 있다.
// 기존 AM 시나리오는 워크플로 화면의 탭 전환과 채팅 탭 빈 상태만 다뤘고, 반복 요청 편집기
// 자체는 어떤 스펙도 잡은 적이 없다.

function editor() {
  return cy.get(".schedule-editor");
}

// 라벨 텍스트는 <span>에 실린다. contains("label", …)로 잡으면 '주기' 셀렉트의 옵션 문구
// ('자동 · 가드 창 간격')까지 걸려 엉뚱한 칸을 잡으므로 span을 정확히 맞춘다. contains는
// 찾을 때까지 재시도하므로 '없음'을 볼 때는 이 헬퍼를 쓰지 않고 칸의 고유 속성으로 본다.
function field(label: string) {
  return editor().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function targetSelect() {
  return field("실행 대상").find("select");
}

function saveButton() {
  return editor().find("footer .button.primary");
}

describe("반복 요청 편집기의 실행 대상 전환", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("대상을 워크플로로 옮기면 채팅 전용 입력·안내가 사라지고, 돌아오면 채워 둔 값이 남는다", () => {
    // 기본 대상은 에이전트 요청이고, 계정이 하나도 없는 격리 환경에서는 전용 배너가 붙는다.
    targetSelect().should("have.value", "chat");
    editor().find(".error-banner").should("exist").and("contain.text", "사용 가능한 계정이 없습니다");

    field("반복할 요청").find("textarea").type("매일 아침 회차 상태를 정리해줘");
    field("작업 경로").find("input").clear().type("/tmp/am-qa-schedule");
    // 채팅 대상의 고급 옵션 요약에는 세션 참조 문구가 붙는다.
    editor().find(".schedule-advanced-toggle small").should("contain.text", "세션 참조");

    // 계정이 없으므로 요청·경로를 다 채워도 저장은 열리지 않는다.
    saveButton().should("be.disabled");

    targetSelect().select("workflow");
    // 채팅 전용 필드가 통째로 내려간다 — 요청 textarea와 작업 경로의 datalist가 사라진다.
    editor().find("textarea").should("not.exist");
    editor().find("#schedule-projects").should("not.exist");
    editor().find(".error-banner").should("not.exist");
    editor().find(".schedule-advanced-toggle small").should("not.contain.text", "세션 참조");

    // 워크플로가 없는 환경에서는 고를 것이 없고 등록 안내가 대신 나오며 저장도 막힌다.
    // 자리표시 option이 disabled라 고를 수 있는 항목이 하나도 없다(select 값은 null이 된다).
    field("실행할 워크플로").find("select option").should("have.length", 1).and("be.disabled");
    editor().find(".schedule-workflow-empty").should("contain.text", "등록된 시스템 워크플로가 없습니다");
    saveButton().should("be.disabled");

    // 되돌아오면 같은 폼 상태이므로 채워 둔 값이 그대로 남아 있어야 한다.
    targetSelect().select("chat");
    field("반복할 요청").find("textarea").should("have.value", "매일 아침 회차 상태를 정리해줘");
    field("작업 경로").find("input").should("have.value", "/tmp/am-qa-schedule");
    editor().find(".error-banner").should("exist").and("contain.text", "사용 가능한 계정이 없습니다");
    editor().find(".schedule-workflow-empty").should("not.exist");
  });

  it("주기를 바꾸면 시각·간격 칸만 갈아끼우고 채운 요청 본문은 유지된다", () => {
    field("반복할 요청").find("textarea").type("주간 요약");

    // 기본 주기(매일)에서는 실행 시각(시=0..23, 분=0..59)이 보이고 간격 칸은 없다.
    editor().find('input[type="number"][max="23"]').should("exist");
    editor().find('input[type="number"][max="59"]').should("exist");
    editor().find('input[type="number"][max="168"]').should("not.exist");

    field("주기").find("select").select("hourly");
    field("간격").find("input").should("have.attr", "max", "168").and("have.attr", "min", "1");
    editor().find('input[type="number"][max="23"]').should("not.exist");

    field("주기").find("select").select("cron");
    editor().find('input[type="number"][max="168"]').should("not.exist");
    field("Cron · 분 시 일 월 요일").find("input").should("have.attr", "placeholder", "0 9 * * 1-5");

    // 주기를 세 번 바꿔도 요청 본문은 손대지 않는다.
    field("반복할 요청").find("textarea").should("have.value", "주간 요약");
  });
});
