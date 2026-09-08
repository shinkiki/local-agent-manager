// 설정 → 플러그인 → SSH에서 격리 HOME 안의 Ed25519 키를 실제로 생성하고,
// 공개키만 펼쳐 본 뒤 확인 대화를 승인해 .ssh 내부 휴지통으로 옮기는 한 생명주기.
describe("SSH 키 생성·공개키 확인·삭제 생명주기", () => {
  it("새 키를 목록에 싣고 공개키만 보여 준 뒤 삭제하면 목록에서 제거한다", () => {
    const fileBase = `am-qa-lifecycle-${Date.now()}`;
    const publicName = `${fileBase}.pub`;
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSettingsTab("plugins");
    cy.anchor("settings.ssh-keys").click();
    cy.anchor("settings.ssh-keys-content").should("be.visible");
    cy.get(".ssh-keys-card").should("not.contain.text", "SSH 키를 확인하는 중…");
    cy.contains(".ssh-key-list .plugin-row", publicName).should("not.exist");

    cy.contains(".ssh-keys-card .settings-update-body button", "키 생성").click();
    cy.get("#ssh-key-file-name").clear().type(fileBase);
    cy.get("#ssh-key-comment").clear().type("agent-manager isolated qa");
    cy.get(".ssh-key-form .form-actions button.primary").click();

    cy.contains(".ssh-key-list .plugin-row", publicName).as("keyRow");
    cy.get("@keyRow").should("contain.text", publicName);
    cy.get("@keyRow").find(".ssh-key-fingerprint").invoke("text").should("match", /^SHA256:/);

    cy.get("@keyRow").contains("button", "공개키 확인").click();
    cy.get(".ssh-key-reveal").should("be.visible");
    cy.get(".ssh-key-reveal pre").invoke("text").should("match", /^ssh-ed25519 [A-Za-z0-9+/=]+ agent-manager isolated qa$/);
    cy.contains(".modal-footer button", "닫기").click();
    cy.get(".ssh-key-reveal").should("not.exist");

    cy.get("@keyRow").find(`button[aria-label="${publicName} 삭제"]`).click();
    cy.get(".confirm-dialog").should("contain.text", ".agent-manager-trash");
    cy.contains(".modal-footer button", "삭제").click();

    cy.contains(".ssh-key-list .plugin-row", publicName).should("not.exist");
    cy.get(".ssh-key-notice").should("contain.text", ".agent-manager-trash");
  });
});
