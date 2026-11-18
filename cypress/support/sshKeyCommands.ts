/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 애드온 → SSH 인증키 카드의 로드 완료 대기 및 키 생성·행 선택·삭제 절차와, 키와 따로
// 저장되는 연결 서버의 추가·행 선택·삭제 절차. 스펙 다섯 곳이 저마다 openSsh를 정의하고
// 키 생성 폼 작성, 확인 모달 승인 삭제를 손으로 적어 두고 있었다. 한 벌로 둔다.

Cypress.Commands.add("openSshKeysTab", () => {
  cy.openAddonsView("ssh");
  cy.anchor("addons.ssh-content").should("be.visible");
  return cy.get(".ssh-keys-card").should("not.contain.text", "SSH 키를 확인하는 중…");
});

Cypress.Commands.add("openSshKeyForm", () => {
  cy.contains(".ssh-keys-card .settings-update-body button", "키 생성").click();
  return cy.get(".ssh-key-form").should("be.visible");
});

Cypress.Commands.add("sshKeyRow", (publicName: string) =>
  cy.contains(".ssh-key-list .plugin-row", publicName),
);

Cypress.Commands.add("createSshKey", (fileBase: string, comment = "agent-manager qa") => {
  cy.openSshKeyForm();
  cy.get("#ssh-key-file-name").clear().type(fileBase);
  if (comment) {
    cy.get("#ssh-key-comment").clear().type(comment);
  }
  cy.get(".ssh-key-form .form-actions button.primary").click();
  return cy.sshKeyRow(`${fileBase}.pub`).should("be.visible");
});

Cypress.Commands.add("deleteSshKey", (publicName: string) => {
  cy.sshKeyRow(publicName).find(`button[aria-label="${publicName} 삭제"]`).click();
  cy.get(".confirm-dialog").should("be.visible");
  cy.contains(".modal-footer button", "삭제").click();
  return cy.contains(".ssh-key-list .plugin-row", publicName).should("not.exist");
});

Cypress.Commands.add("sshServerRow", (label: string) =>
  cy.contains(".ssh-server-list .plugin-row", label),
);

// 인증키 선택 상자의 항목 글은 "파일 이름 · 알고리즘"이다. 알고리즘을 스펙마다 적지 않도록
// 파일 이름이 든 항목을 찾아 그 값(지문)으로 고른다.
Cypress.Commands.add("selectSshServerKey", (scope: string, publicName: string) =>
  cy.get(scope).find("select[id^='ssh-server-key-']").then(($select) => {
    const option = $select.find("option").filter((_, element) => (element.textContent ?? "").includes(publicName));
    expect(option.length, `인증키 항목 ${publicName}`).to.eq(1);
    return cy.wrap($select).select(String(option.val()));
  }),
);

Cypress.Commands.add("addSshServer", ({ name, host, user, port, keyPublicName }) => {
  cy.contains(".ssh-section-head button", "서버 추가").click();
  cy.get(".ssh-server-new .ssh-server-form").should("be.visible");
  cy.get("#ssh-server-name-new").clear().type(name);
  cy.get("#ssh-server-host-new").clear().type(host);
  cy.get("#ssh-server-user-new").clear().type(user);
  if (port) {
    cy.get("#ssh-server-port-new").clear().type(port);
  }
  cy.selectSshServerKey(".ssh-server-new", keyPublicName);
  cy.contains(".ssh-server-new .form-actions button.primary", "추가").click();
  cy.get(".ssh-server-new").should("not.exist");
  return cy.sshServerRow(name).should("be.visible");
});

Cypress.Commands.add("deleteSshServer", (label: string) => {
  cy.sshServerRow(label).find(`button[aria-label="${label} 서버 삭제"]`).click();
  cy.get(".confirm-dialog").should("be.visible");
  cy.contains(".modal-footer button", "삭제").click();
  return cy.contains(".ssh-server-list .plugin-row", label).should("not.exist");
});
