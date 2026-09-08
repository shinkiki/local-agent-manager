/// <reference types="cypress" />
// 공용 확인 대화상자(useConfirm)는 src/components/Shared.tsx의 ConfirmDialog에서 "실행
// 버튼에 포커스를 두어 Enter로 확인, Esc로 취소가 되게 한다"고 약속한다. 기존 확인 대화
// 스펙(am20260907-session-folder-delete, am20260906-skill-bulk-bar-confirm,
// am20260907-remote-write-language)은 모두 버튼을 마우스로 눌러 흐름만 보므로 이 키보드
// 약속은 아무도 보지 않았다. 그래서 마우스를 쓰지 않고 Esc만으로 취소가 되는지, 그리고
// 취소가 값을 남기지 않는지를 본다.
// Enter 확인과 Tab 초점 가둠은 Cypress 합성 키로 확인할 수 없어 뺐다 — `{tab}`은 지원
// 문자열이 아니고, 버튼에 보낸 `{enter}`는 click을 일으키지 않는다(cypress-real-events 미설치).
// 방아쇠는 "원격 편집 허용" 스위치다. 격리 백엔드는 임시 app-data에만 쓰고 Tailscale CLI를
// 부르지 않아 껐다 켜도 운영 설정에 닿지 않는다. 값은 백엔드에 남아 뒤따르는 스펙으로 새므로
// 끝에서 기본값(켜짐)으로 되돌린다.
// 주의: 상태 조회가 끝나기 전에는 스위치가 꺼진 모양으로 그려지므로(tailscale 상태 초기값
// null), 조작 전에 켜짐이 보일 때까지 기다려 로딩 중 값을 실제 값으로 오인하지 않는다.
const TOGGLE = '[role="switch"][aria-label="원격 편집 허용"]';
const DIALOG = '[role="dialog"]';

/** 상태 조회가 끝난(켜짐) 스위치를 확인하고 끈다 — 끄는 쪽은 확인 대화가 없다. */
function openServiceTabAndTurnOff() {
  cy.openSettingsTab("service");
  cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
  cy.get(TOGGLE).click();
  cy.get(DIALOG).should("not.exist");
  cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
}

describe("공용 확인 대화상자 · 키보드 취소 계약", () => {
  after(() => {
    cy.visitApp();
    cy.openSettingsTab("service");
    cy.get(TOGGLE).then(($toggle) => {
      if ($toggle.attr("aria-checked") === "true") return;
      cy.get(TOGGLE).click();
      cy.get(DIALOG).contains("button", "허용").click();
      cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    });
  });

  it("열리면 실행 버튼에 초점이 있고 Esc로 취소되며 값은 바뀌지 않는다", () => {
    cy.visitApp();
    openServiceTabAndTurnOff();

    // 켜는 쪽만 확인을 받는다.
    cy.get(TOGGLE).click();
    cy.get(DIALOG).should("be.visible");

    // 1) 초기 초점이 실행 버튼(허용)에 있다 — Enter 확인 약속의 전제다.
    cy.focused().should("have.text", "허용");

    // 2) Esc는 취소다 — 대화가 닫히고 스위치는 꺼진 채 남는다.
    cy.get("body").type("{esc}");
    cy.get(DIALOG).should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");

    // 3) 취소는 백엔드에 값을 남기지 않는다 — 새로고침 뒤에도 꺼져 있다.
    cy.reload();
    cy.openSettingsTab("service");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
  });
});
