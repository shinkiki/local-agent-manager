/// <reference types="cypress" />
// C20 설정 → 시스템 → 로그인 설정 카드. 실제 격리 백엔드를 상대로 비밀번호를 두고(argon2id),
// 채널 표의 ID/비밀번호 스위치가 열리는지, OTP 등록 시작이 QR과 수동 키를 보여 주는지, 그리고
// 비밀번호 해제가 현재 비밀번호 재인증을 요구하는지를 본다.
//
// **채널 요구는 켜지 않는다.** 격리 백엔드는 스펙 사이에 살아 있어(docs/E2E.md), 로컬
// 브라우저 채널에 요구를 켜 두면 뒤따르는 스펙이 전부 로그인 화면에 막힌다. 켜기 흐름은
// login-gate·am20260907-confirm-dialog-keyboard가 스텁으로 본다. 끝에서 비밀번호도 해제해
// 백엔드를 들어왔을 때 상태로 되돌린다.
const CARD = ".login-settings-card";
const PASSWORD = "e2e-password-123";
const localToggle = (method: string) => cy.get(`${CARD} tr[data-login-channel="localBrowser"] [role="switch"][aria-label*="${method}"]`);

const openCard = () => {
  cy.visitApp();
  cy.openSettingsTab("service");
  // 카드는 시스템 탭 아래쪽에 서므로 스크롤해 들여온다.
  cy.get(CARD).scrollIntoView().should("be.visible");
};

describe("C20 · 로그인 설정 카드", () => {
  after(() => {
    // 실패로 끊겨도 비밀번호가 남지 않도록 API로 직접 되돌린다. 요구를 켜지 않았으므로
    // 이 호출에는 세션이 필요 없다.
    cy.request({
      method: "POST",
      url: "/api/invoke/clear_login_password",
      headers: { "Content-Type": "application/json" },
      body: { currentPassword: PASSWORD },
      failOnStatusCode: false,
    });
  });

  it("비밀번호를 두면 채널 표의 ID/비밀번호 스위치가 열리고, 해제는 현재 비밀번호를 요구한다", () => {
    openCard();

    // 1) 아무것도 설정되지 않은 상태: 요약은 "로그인 없이", 스위치는 전부 잠겨 있다.
    cy.get(`${CARD} header small`).should("contain.text", "모든 채널이 로그인 없이 열립니다");
    localToggle("ID/비밀번호").should("be.disabled");
    localToggle("OTP").should("be.disabled");

    // 2) 비밀번호 설정 — 첫 설정은 재인증 칸이 없다.
    cy.get(CARD).contains("button", "설정").click();
    cy.get(`${CARD} .login-settings-form`).should("be.visible");
    cy.get(`${CARD} .login-settings-form input[autocomplete="current-password"]`).should("not.exist");
    cy.get(`${CARD} .login-settings-form input[autocomplete="username"]`).clear().type("e2e");
    cy.get(`${CARD} .login-settings-form input[autocomplete="new-password"]`).eq(0).type(PASSWORD);
    cy.get(`${CARD} .login-settings-form input[autocomplete="new-password"]`).eq(1).type(PASSWORD);
    cy.get(`${CARD} .login-settings-form`).contains("button", "저장").click();
    cy.get(`${CARD} .settings-success`).should("contain.text", "비밀번호를 저장했습니다");
    cy.get(CARD).should("contain.text", "아이디 e2e · 비밀번호 설정됨");

    // 3) 이제 ID/비밀번호 스위치는 열리고 OTP 스위치는 여전히 잠겨 있다(미등록).
    localToggle("ID/비밀번호").should("be.enabled").and("have.attr", "aria-checked", "false");
    localToggle("OTP").should("be.disabled");

    // 4) OTP 등록 시작 — 비밀번호가 있으므로 재인증을 묻고, QR과 수동 키가 뜬다. 확인 코드는
    //    인증 앱이 있어야 하므로 여기서 끝낸다(아무것도 저장되지 않는다).
    cy.get(CARD).contains("button", "등록").click();
    cy.get(`${CARD} .login-settings-form input[autocomplete="current-password"]`).type(PASSWORD);
    cy.get(`${CARD} .login-settings-form`).contains("button", "시작").click();
    cy.get(`${CARD} .login-otp-qr img`).should("be.visible").and("have.attr", "src").and("match", /^data:image\/svg\+xml/);
    cy.get(`${CARD} [data-login-otp-secret]`).invoke("text").should("match", /^[A-Z2-7 ]{32,}$/);
    cy.get(`${CARD} .login-otp-enroll`).contains("button", "취소").click();
    cy.get(CARD).should("contain.text", "등록된 인증 앱이 없습니다");

    // 4b) 변경이 거절돼도 입력한 칸은 남는다 — 틀린 현재 비밀번호 하나 때문에 새 비밀번호 두 칸을
    //     다시 치게 하지 않는다. 취소로 아무것도 바꾸지 않고 닫는다.
    cy.get(CARD).contains("button", "변경").click();
    cy.get(`${CARD} .login-settings-form input[autocomplete="current-password"]`).type("not-the-password");
    cy.get(`${CARD} .login-settings-form input[autocomplete="new-password"]`).eq(0).type("e2e-next-password");
    cy.get(`${CARD} .login-settings-form input[autocomplete="new-password"]`).eq(1).type("e2e-next-password");
    cy.get(`${CARD} .login-settings-form`).contains("button", "저장").click();
    cy.get(`${CARD} .error-banner`).should("contain.text", "맞지 않습니다");
    cy.get(`${CARD} .login-settings-form input[autocomplete="new-password"]`).eq(0).should("have.value", "e2e-next-password");
    cy.get(`${CARD} .login-settings-form input[autocomplete="new-password"]`).eq(1).should("have.value", "e2e-next-password");
    cy.get(`${CARD} .login-settings-form input[autocomplete="current-password"]`).should("have.value", "not-the-password");
    cy.get(`${CARD} .login-settings-form`).contains("button", "취소").click();

    // 5) 해제는 현재 비밀번호를 요구한다 — 틀리면 거절, 맞으면 해제.
    cy.get(CARD).contains("button", "해제").click();
    cy.get(`${CARD} .login-settings-form input[autocomplete="current-password"]`).type("not-the-password");
    cy.get(`${CARD} .login-settings-form`).contains("button", "해제").click();
    cy.get(`${CARD} .error-banner`).should("contain.text", "맞지 않습니다");
    cy.get(`${CARD} .login-settings-form input[autocomplete="current-password"]`).clear().type(PASSWORD);
    cy.get(`${CARD} .login-settings-form`).contains("button", "해제").click();
    cy.get(`${CARD} .settings-success`).should("contain.text", "비밀번호를 해제했습니다");
    localToggle("ID/비밀번호").should("be.disabled");
  });
});
