/**
 * 페이싱 스케줄 버튼에 붙는 요약 한 줄이 저장한 요일 조합을 어떻게 줄이는지 본다.
 * 기존 `am20260906-pacing-quiet-hours-bounds`는 모달 안의 저장 잠금 경계와 저장 후 복원까지만
 * 본다. 화면 밖으로 나온 요약(`describeQuietHours`)이 전부·연속·비연속 세 갈래를 제대로
 * 갈라 쓰는지는 어느 스펙도 보지 않았다. 특히 화면의 요일 순서는 월~일이라 연속 판정이
 * 요일 번호가 아니라 표시 자리를 따라야 하고(목~일은 연속, 일~월은 아님), 그 자리가
 * 어긋나면 요약만 조용히 틀린다.
 */
describe("페이싱 스케줄 요일 요약", () => {
  // 화면의 요일 상자는 월~일 순이다: 0=월 … 5=토 6=일.
  const scheduleSummary = () => cy.anchor("workflows.usage-budget.schedule").find("small");

  const saveQuiet = () => {
    cy.quietHoursSave().should("not.be.disabled").click();
    cy.get(".modal").should("not.exist");
    cy.get(".error-banner").should("not.exist");
  };

  beforeEach(() => {
    cy.visitApp();
    cy.openView("workflows");
    cy.anchor("workflows.tab.recurring").click();
  });

  it("전체·연속·비연속 요일이 매일·범위·나열로 각각 다르게 줄어든다", () => {
    // 꺼져 있는 동안에는 요약할 시간대 자체가 없어 버튼에 부제가 붙지 않는다.
    cy.anchor("workflows.usage-budget.schedule").find("small").should("not.exist");

    // 연속 구간 — 기본 월~금 다섯을 그대로 저장하면 범위로 줄어든다.
    cy.openPacingScheduleModal();
    cy.quietHoursToggle().click();
    cy.quietHoursWeekdays().filter(":checked").should("have.length", 5);
    saveQuiet();
    scheduleSummary().should("have.text", "제한 09:00~18:00 · 월~금");

    // 전부 — 토·일까지 채우면 범위가 아니라 "매일"이다.
    cy.openPacingScheduleModal();
    cy.quietHoursWeekdays().eq(5).click();
    cy.quietHoursWeekdays().eq(6).click();
    saveQuiet();
    scheduleSummary().should("have.text", "제한 09:00~18:00 · 매일");

    // 주말에 걸친 연속 구간 — 목·금·토·일은 표시 자리가 이어져 있으므로 "목~일"이다.
    // 요일 번호(4,5,6,0)로는 이어지지 않아, 여기서 번호가 아니라 자리를 본다는 것이 드러난다.
    cy.openPacingScheduleModal();
    cy.quietHoursWeekdays().eq(0).click();
    cy.quietHoursWeekdays().eq(1).click();
    cy.quietHoursWeekdays().eq(2).click();
    cy.quietHoursWeekdays().filter(":checked").should("have.length", 4);
    saveQuiet();
    scheduleSummary().should("have.text", "제한 09:00~18:00 · 목~일");

    // 비연속 — 가운데 금요일 하나가 빠지면 범위로 묶지 않고 낱개로 나열한다.
    cy.openPacingScheduleModal();
    cy.quietHoursWeekdays().eq(4).click();
    saveQuiet();
    scheduleSummary().should("have.text", "제한 09:00~18:00 · 목·토·일");

    // 스위치를 다시 끄면 저장된 요일이 남아 있어도 요약이 사라진다 — 종일 도는 상태다.
    cy.openPacingScheduleModal();
    cy.quietHoursToggle().click();
    saveQuiet();
    cy.anchor("workflows.usage-budget.schedule").find("small").should("not.exist");
  });
});
