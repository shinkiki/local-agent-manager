import { usageBudget } from "../support/workflowFixtures";

// 페이싱 머리줄(UsageBudgetPanel.tsx:851)의 조작 자리는 페이싱 스위치·스케줄 버튼·새로고침
// 아이콘 세 개를 한 줄에 늘어놓는다. 스케줄 버튼에는 저장된 제한 시간대 요약이 `small`로
// 따라붙어(같은 파일 867) 문자열이 길다. 600px 이하에서 이 줄이 줄바꿈하지 않아 버튼이
// 잘리던 것을 f382a57이 `flex-wrap: wrap`과 두 항목의 `flex: 1 0 100%`로 고쳤다.
//
// 좁은 화면 경계를 보는 스펙은 상태바(am20260907-sidebar-usage-meters.cy.ts) 하나뿐이고
// 페이싱 머리줄은 어느 스펙도 폭을 보지 않는다. 기존 페이싱 스펙들은 모두 기본 뷰포트에서
// 값·문구만 본다. 그래서 이 스펙은 문구가 아니라 배치만 붙잡는다 — 좁은 화면에서 두 항목이
// 각자 한 줄을 차지하며 잘리지 않는지, 넓은 화면에서는 다시 한 줄로 모이는지.
const ACTIONS = ".workflow-overview-actions";
const NARROW = 560;

// 요일이 연속하지 않으면 "월·수·금·일"로 펼쳐져 요약이 가장 길어진다(pacingSchedule.ts:31).
const QUIET_HOURS = { enabled: true, start: "09:00", end: "18:00", timezone: "Asia/Seoul", weekdays: [1, 3, 5, 0] };
const QUIET_SUMMARY = "제한 09:00~18:00 · 월·수·금·일";

function openPacing(width: number) {
  cy.stubInvoke("get_usage_budget", {
    ...usageBudget({ pacingWorkflowIds: ["wf-paced"] }),
    defaults: { windowLabel: "7일", targetPercent: 95, guardWindowLabel: "5시간", guardPercent: 90, enabled: true, quietHours: QUIET_HOURS },
  });
  cy.viewport(width, 900);
  cy.visitApp();
  cy.openPacingTab();
  // 요약이 실제로 붙은 상태여야 잘림을 볼 수 있다. 붙지 않으면 이 시나리오는 무의미하다.
  cy.anchor("workflows.usage-budget.schedule").find("small").should("have.text", QUIET_SUMMARY);
}

/** 요소의 뷰포트 기준 사각형. 잘림은 부모 대비 폭이 아니라 실제 사각형으로 판정한다. */
function rect(selector: string) {
  return cy.get(selector).then(($el) => $el[0].getBoundingClientRect());
}

describe("좁은 화면 페이싱 머리줄의 조작 줄 줄바꿈", () => {
  it("560px에서 스위치와 스케줄 버튼이 각자 한 줄을 차지하고 요약까지 잘리지 않는다", () => {
    openPacing(NARROW);

    // 1) 페이지 전체가 뷰포트보다 넓어지면 원격 모바일 화면에서 오른쪽 조작을 잃는다.
    cy.document().then((doc) => {
      expect(doc.documentElement.scrollWidth).to.be.at.most(doc.documentElement.clientWidth);
    });

    // 2) 조작 줄 안에서도 내용이 넘치지 않아야 한다(넘치면 버튼 끝이 잘린 채 숨는다).
    cy.get(ACTIONS).then(($row) => {
      expect($row[0].scrollWidth).to.be.at.most($row[0].clientWidth + 1);
    });

    // 3) 두 항목은 서로 다른 줄에 있고 각자 줄 폭을 다 쓴다.
    cy.get(ACTIONS).then(($row) => {
      const row = $row[0].getBoundingClientRect();
      rect(`${ACTIONS} > .workflow-pacing-control`).then((control) => {
        rect(`${ACTIONS} > .button`).then((button) => {
          expect(button.top).to.be.greaterThan(control.bottom - 1);
          expect(control.width).to.be.closeTo(row.width, 1);
          expect(button.width).to.be.closeTo(row.width, 1);
          // 두 항목 모두 줄 안에 들어와야 한다 — 오른쪽이 삐져나가면 그것이 잘림이다.
          expect(button.right).to.be.at.most(row.right + 1);
          expect(control.right).to.be.at.most(row.right + 1);
        });
      });
    });

    // 4) 요약 문구가 줄바꿈해도 버튼 안에 남아야 한다(버튼이 내용을 자르면 요약이 사라진다).
    cy.anchor("workflows.usage-budget.schedule").then(($button) => {
      const button = $button[0];
      expect(button.scrollWidth).to.be.at.most(button.clientWidth + 1);
      const small = button.querySelector("small") as HTMLElement;
      const box = button.getBoundingClientRect();
      const tail = small.getBoundingClientRect();
      expect(tail.right).to.be.at.most(box.right + 1);
      expect(tail.bottom).to.be.at.most(box.bottom + 1);
    });

    // 5) 새로고침 아이콘은 줄에서 빠져 카드 오른쪽 위에 절대 배치된다. 줄바꿈에 밀려
    //    화면 밖으로 나가면 좁은 화면에서 다시 읽을 방법이 없다.
    cy.get(`${ACTIONS} > .icon-button`).should("be.visible").then(($icon) => {
      const icon = $icon[0].getBoundingClientRect();
      expect(icon.left).to.be.at.least(0);
      expect(icon.right).to.be.at.most(NARROW);
    });

    // 6) 잘려 보이지 않는 것과 누를 수 있는 것은 다르다. 실제로 스케줄 모달까지 열린다.
    cy.anchor("workflows.usage-budget.schedule").click();
    cy.get(".modal").should("be.visible");
  });

  it("1280px에서는 세 조작이 다시 한 줄에 모인다", () => {
    openPacing(1280);

    rect(`${ACTIONS} > .workflow-pacing-control`).then((control) => {
      rect(`${ACTIONS} > .button`).then((button) => {
        // 같은 줄: 세로로 겹친다. 넓은 화면에서 줄바꿈이 남으면 머리줄이 헐거워진다.
        expect(button.top).to.be.lessThan(control.bottom);
        expect(control.top).to.be.lessThan(button.bottom);
        // 줄 폭을 독차지하지 않는다(좁은 화면 규칙이 새어 나오지 않았는지).
        cy.get(ACTIONS).then(($row) => {
          expect(button.width).to.be.lessThan($row[0].getBoundingClientRect().width);
        });
      });
    });
  });
});
