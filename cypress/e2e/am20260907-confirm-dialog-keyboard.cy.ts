/// <reference types="cypress" />
// 공용 확인 대화상자(useConfirm)는 src/components/Shared.tsx의 ConfirmDialog에서 "실행
// 버튼에 포커스를 두어 Enter로 확인, Esc로 취소가 되게 한다"고 약속한다. 기존 확인 대화
// 스펙(am20260907-session-folder-delete, am20260906-skill-bulk-bar-confirm)은 모두 버튼을
// 마우스로 눌러 흐름만 보므로 이 키보드 약속은 아무도 보지 않았다. 그래서 마우스를 쓰지
// 않고 Esc만으로 취소가 되는지, 그리고 취소가 값을 남기지 않는지를 본다.
// Enter 확인과 Tab 초점 가둠은 Cypress 합성 키로 확인할 수 없어 뺐다 — `{tab}`은 지원
// 문자열이 아니고, 버튼에 보낸 `{enter}`는 click을 일으키지 않는다(cypress-real-events 미설치).
// 방아쇠는 설정 → 시스템 → 로그인 설정에서 **지금 보고 있는 채널**(로컬 브라우저)에
// ID/비밀번호 로그인을 켜는 스위치다 — 그 방향만 확인을 받는다(LoginSettingsCard.tsx).
// 로그인 설정 조회와 저장은 전부 가로채므로 격리 백엔드에 값이 남지 않고, 취소 경로에서는
// 저장 명령이 아예 나가지 않는다.
const TOGGLE = '[role="switch"][aria-label="로컬 브라우저 ID/비밀번호 로그인"]';
const DIALOG = '[role="dialog"].modal, .confirm-dialog';

const settings = {
  userId: "qa",
  passwordConfigured: true,
  otpConfigured: false,
  otpSecretStorage: null,
  channels: {
    desktop: { password: false, otp: false },
    localBrowser: { password: false, otp: false },
    remote: { password: false, otp: false },
  },
};

describe("공용 확인 대화상자 · 키보드 취소 계약", () => {
  it("열리면 실행 버튼에 초점이 있고 Esc로 취소되며 값은 바뀌지 않는다", () => {
    const calls: unknown[] = [];
    cy.stubInvoke("get_login_settings", { statusCode: 200, body: settings });
    cy.stubInvoke("list_login_sessions", { statusCode: 200, body: [] });
    cy.stubInvoke("set_login_channel_requirement", (req) => {
      calls.push(req.body);
      req.reply({ statusCode: 200, body: settings });
    });
    cy.visitApp();
    cy.openSettingsTab("service");
    cy.get(".login-settings-card").scrollIntoView().should("be.visible");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false").and("be.enabled");

    // 지금 보고 있는 채널에 켜는 쪽만 확인을 받는다.
    cy.get(TOGGLE).click();
    cy.get(".confirm-dialog").should("be.visible");

    // 1) 초기 초점이 실행 버튼(켜기)에 있다 — Enter 확인 약속의 전제다.
    cy.focused().should("have.text", "켜기");

    // 2) Esc는 취소다 — 대화가 닫히고 스위치는 꺼진 채 남는다.
    cy.get("body").type("{esc}");
    cy.get(DIALOG).should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");

    // 3) 취소는 저장 명령을 내보내지 않는다.
    cy.then(() => expect(calls, "취소 뒤 저장 호출").to.have.length(0));
  });
});
