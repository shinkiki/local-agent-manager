// 반복 요청 편집기의 '주기' 전환이 조건부 칸(간격·실행 시각·요일·Cron)을 갈아끼우는 계약과,
// 숫자 칸의 경계값 처리를 붙잡는다.
// - 조건부 칸 조건: src/components/ChatSchedules.tsx:394
//   hourly → 간격(min 1, max 168) / daily·weekdays·weekly → 실행 시각(0~23 : 0~59)
//   weekly → 요일 / cron → Cron 한 줄 / auto → 아무 칸도 없음
// - 기본값: ChatSchedules.tsx:282-287 (daily · 간격 1 · 09:00 · 월요일 · "0 9 * * 1-5")
// 값은 한 컴포넌트 상태에 함께 살아 있으므로 주기를 오갔다 돌아오면 채워 둔 값이 남아야 한다.
// 숫자 칸은 문자열 초안으로 들고 있다가 칸을 떠날 때 범위로 자른다(clampScheduleNumber). 치는
// 도중에는 범위 밖·빈 값이 그대로 남고, 빈 칸에 0이 끼어들지 않아야 한다(QA #33).
// 기존 AM 시나리오는 이 편집기의 '실행 대상' 전환과 세션 참조 고급 옵션만 다뤘고, 주기 칸 묶음은
// 어떤 스펙도 잡은 적이 없다.

function editor() {
  return cy.get(".schedule-editor");
}

// 라벨 텍스트는 <span>에 실린다. '없음'을 볼 때는 이 헬퍼를 쓰지 않고(재시도로 시간을 버린다)
// 칸의 고유 속성으로 본다.
function field(label: string) {
  return editor().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function frequencySelect() {
  return field("주기").find("select");
}

function intervalInput() {
  return editor().find('input[type="number"][max="168"]');
}

function timeInputs() {
  return editor().find(".time-fields input");
}

function cronInput() {
  return editor().find('input[placeholder="0 9 * * 1-5"]');
}

describe("반복 요청 편집기의 주기 전환과 숫자 칸 경계", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("주기마다 드러나는 칸이 다르고, 오갔다 돌아와도 채운 값이 남는다", () => {
    // 기본은 '매일'이라 실행 시각만 있고 간격·요일·Cron은 없다.
    frequencySelect().should("have.value", "daily");
    timeInputs().should("have.length", 2);
    timeInputs().eq(0).should("have.value", "9").and("have.attr", "max", "23");
    timeInputs().eq(1).should("have.value", "0").and("have.attr", "max", "59");
    editor().find('input[type="number"][max="168"]').should("not.exist");
    editor().find('input[placeholder="0 9 * * 1-5"]').should("not.exist");

    // 매 N시간은 실행 시각을 걷어내고 간격 칸만 남긴다.
    frequencySelect().select("hourly");
    intervalInput().should("have.value", "1").and("have.attr", "min", "1");
    editor().find(".time-fields").should("not.exist");

    // 매주는 실행 시각과 요일을 함께 낸다. 요일 기본은 월요일이다.
    frequencySelect().select("weekly");
    editor().find('input[type="number"][max="168"]').should("not.exist");
    timeInputs().should("have.length", 2);
    field("요일").find("select").should("have.value", "1");

    // 평일은 실행 시각만 남고 요일 칸은 사라진다.
    frequencySelect().select("weekdays");
    timeInputs().should("have.length", 2);
    editor().find("select").should("not.have.value", "요일");
    editor().contains("label > span", /^요일$/).should("not.exist");

    // 고급 Cron은 숫자 칸을 모두 걷어내고 한 줄 입력만 낸다.
    frequencySelect().select("cron");
    editor().find(".time-fields").should("not.exist");
    cronInput().should("have.value", "0 9 * * 1-5");

    // 자동은 어떤 주기 칸도 내지 않는다.
    frequencySelect().select("auto");
    editor().find(".time-fields").should("not.exist");
    editor().find('input[type="number"][max="168"]').should("not.exist");
    editor().find('input[placeholder="0 9 * * 1-5"]').should("not.exist");

    // 값은 한 상태에 함께 살아 있으므로 채워 두고 다른 주기를 다녀와도 남는다.
    frequencySelect().select("weekly");
    timeInputs().eq(0).type("{selectall}21");
    timeInputs().eq(1).type("{selectall}45");
    field("요일").find("select").select("5");
    frequencySelect().select("cron");
    cronInput().clear().type("15 3 * * 6");
    frequencySelect().select("weekly");
    timeInputs().eq(0).should("have.value", "21");
    timeInputs().eq(1).should("have.value", "45");
    field("요일").find("select").should("have.value", "5");
    frequencySelect().select("cron");
    cronInput().should("have.value", "15 3 * * 6");
  });

  it("숫자 칸은 치는 동안 그대로 두고 칸을 떠날 때 범위로 자르며, 비운 칸에 0을 끼우지 않는다", () => {
    frequencySelect().select("hourly");
    intervalInput().should("have.attr", "min", "1").and("have.attr", "max", "168");

    // 상한 경계는 그대로 들어간다.
    intervalInput().type("{selectall}168").should("have.value", "168");

    // 치는 도중에는 상한을 넘긴 값도 그대로 보이고, 칸을 떠나면 168로 잘린다.
    intervalInput().type("{selectall}999").should("have.value", "999");
    intervalInput().blur().should("have.value", "168");

    // QA #33 되짚기: 칸을 비우면 예전엔 Number("")가 0이 되어 곧바로 0이 들어찼다. 이제 빈 칸은
    // 빈 채로 남는다.
    intervalInput().clear().should("have.value", "");

    // 그래서 지우고 다시 치면 의도한 12가 그대로 들어간다(예전엔 0 뒤에 붙어 120이 됐다).
    intervalInput().clear().type("12").should("have.value", "12");

    // 빈 채로 칸을 떠나면 하한(1)으로 떨어진다.
    intervalInput().clear().blur().should("have.value", "1");

    // 실행 시각도 같은 규칙이다: 치는 동안 24시·60분이 보이다가 떠나면 23·59로 잘리고,
    // 비운 칸은 0이 되지 않는다.
    frequencySelect().select("daily");
    timeInputs().eq(0).type("{selectall}24").should("have.value", "24");
    timeInputs().eq(0).blur().should("have.value", "23");
    timeInputs().eq(1).type("{selectall}60").should("have.value", "60");
    timeInputs().eq(1).blur().should("have.value", "59");
    timeInputs().eq(0).clear().should("have.value", "");
    timeInputs().eq(0).type("7").should("have.value", "7");
  });
});
