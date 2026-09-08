// 원격 편집 허용은 "원격 접속"의 권한만 좁히는 설정이다. 호스트 화면에서 이 설정을
// 껐다고 해서 호스트 자신의 편집 수단까지 잠기면 안 된다(SshKeysCard.tsx:85-86의
// canWrite/isRemote 분리). remote-write.cy.ts는 같은 탭 안의 확인 대화와 새로고침
// 잔존만 보므로, 여기서는 끈 상태가 다른 탭의 편집 수단으로 새는지와 탭을 오간 뒤에도
// 값이 남는지를 본다. 격리 백엔드는 임시 app-data에만 쓰고 Tailscale CLI를 부르지
// 않으므로 여기서 껐다 켜도 운영 설정에 닿지 않는다.
// 값이 백엔드에 남아 뒤따르는 스펙으로 새므로 마지막에 기본값(켜짐)으로 되돌린다.
const TOGGLE = '[role="switch"][aria-label="원격 편집 허용"]';
const ON_SUMMARY = "원격에서도 데스크톱과 같이 변경할 수 있습니다";
const OFF_SUMMARY = "원격은 읽기 전용입니다";
const REMOTE_LOCK_NOTICE = "이 원격 연결은 읽기 전용입니다";

describe("원격 편집 끄기의 적용 범위 · 호스트 화면", () => {
  const openService = () => {
    cy.openSettingsTab("service");
    cy.get(TOGGLE).should("exist");
  };

  const openSsh = () => {
    cy.openSettingsTab("plugins");
    cy.anchor("settings.ssh-keys").click();
    cy.anchor("settings.ssh-keys-content").should("be.visible");
    cy.get(".ssh-keys-card").should("not.contain.text", "SSH 키를 확인하는 중…");
  };

  it("끈 상태는 호스트의 SSH 키 편집을 잠그지 않고, 탭을 오가도 값은 남는다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");

    // 사전조건: 기본값은 켜짐이고 호스트 화면이라 바꿀 수 있다.
    openService();
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true").and("be.enabled");
    cy.contains(ON_SUMMARY).should("be.visible");

    // 1) 끄는 쪽은 좁히는 방향이라 확인 없이 바로 반영된다.
    cy.get(TOGGLE).click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.contains(OFF_SUMMARY).should("be.visible");

    // 2) 다른 탭의 편집 수단은 그대로다 — 이 잠금은 원격 접속에만 걸린다.
    openSsh();
    cy.get(".ssh-keys-card").should("not.contain.text", REMOTE_LOCK_NOTICE);
    cy.contains(".ssh-keys-card .settings-update-body button", "키 생성")
      .should("be.visible")
      .and("be.enabled");

    // 폼도 끝까지 열리고 저장 수단이 살아 있어야 한다.
    cy.contains(".ssh-keys-card .settings-update-body button", "키 생성").click();
    cy.get(".ssh-key-form").should("be.visible");
    cy.get(".ssh-key-form .form-actions button.primary").should("be.enabled");
    cy.contains(".ssh-key-form .form-actions button", "취소").click();
    cy.get(".ssh-key-form").should("not.exist");

    // 3) 탭을 오간 뒤에도 끈 값이 남는다(백엔드에 저장되는 설정).
    openService();
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.contains(OFF_SUMMARY).should("be.visible");

    // 4) 뒤따르는 스펙을 위해 기본값(켜짐)으로 되돌린다. 켜는 쪽은 확인을 거친다.
    cy.get(TOGGLE).click();
    cy.get('[role="dialog"]').contains("button", "허용").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.contains(ON_SUMMARY).should("be.visible");
  });
});
