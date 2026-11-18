// 원격접근: 설정 → 애드온 → SSH → 연결 서버 → 서버 줄의 [연결 확인]·[수정]
// '연결 확인' 결과 영수증(.ssh-key-check)은 그 결과를 낸 서버 줄에만 붙고, 수정 폼을 열거나
// 다른 서버의 폼을 열었을 때 남아 있지 않은지 확인한다. 영수증은 특정 서버의 저장본에 붙어
// 본 결과이므로, 다른 줄이나 고치는 중인 폼 옆에 그대로 보이면 사용자가 엉뚱한 서버의 도달
// 여부로 읽게 된다. 두 서버는 같은 키를 쓴다 — 키 하나를 여러 서버가 함께 쓸 수 있다.
describe("SSH 연결 확인 영수증이 서버 줄에만 붙고 폼 열기에서 비워진다", () => {
  const base = `am-qa-receipt-${Date.now()}`;
  const pub = `${base}.pub`;
  const serverA = `qa-receipt-a-${Date.now()}`;
  const serverB = `qa-receipt-b-${Date.now()}`;

  before(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
    cy.createSshKey(base, "ssh-receipt-test");
    // 닿지 않는 포트를 골라 확인이 빨리 실패하게 한다.
    cy.addSshServer({ name: serverA, host: "127.0.0.1", user: "qauser", port: "1", keyPublicName: pub });
    cy.addSshServer({ name: serverB, host: "127.0.0.1", user: "qauser", port: "2", keyPublicName: pub });
  });

  after(() => {
    cy.deleteSshServer(serverA);
    cy.deleteSshServer(serverB);
    cy.deleteSshKey(pub);
  });

  it("수정 폼을 열거나 다른 서버의 폼을 열면 이전 연결 확인 결과가 남지 않는다", () => {
    cy.sshServerRow(serverA).as("rowA");
    cy.sshServerRow(serverB).as("rowB");

    // 1. A 서버로 연결 확인을 눌러 영수증을 띄운다. 닿지 않으므로 실패 영수증이어야 한다.
    cy.get("@rowA").contains("button", "연결 확인").should("not.be.disabled").click();
    cy.get("@rowA").find(".ssh-key-check", { timeout: 40000 }).should("be.visible");
    cy.get("@rowA").find(".ssh-key-check code").should("contain.text", "127.0.0.1");
    // 영수증은 그 결과를 낸 줄에만 붙는다.
    cy.get("@rowB").find(".ssh-key-check").should("not.exist");

    // 2. A의 수정 폼을 열면 영수증은 버려진다(저장본이 바뀔 수 있다). 저장본은 그대로 펴진다.
    cy.get("@rowA").contains("button", /^수정$/).click();
    cy.get("@rowA").find(".ssh-server-form").should("be.visible");
    cy.get("@rowA").find(".ssh-key-check").should("not.exist");
    cy.get("@rowA").find("input[id^='ssh-server-host-']").should("have.value", "127.0.0.1");
    cy.get("@rowA").find("input[id^='ssh-server-port-']").should("have.value", "1");
    cy.get("@rowA").find(".ssh-server-form .form-actions").contains("button", "취소").click();
    cy.get("@rowA").find(".ssh-server-form").should("not.exist");

    // 3. 다시 확인해 영수증을 띄운 뒤, 곧바로 다른 서버의 폼을 연다.
    cy.get("@rowA").contains("button", "연결 확인").should("not.be.disabled").click();
    cy.get("@rowA").find(".ssh-key-check", { timeout: 40000 }).should("be.visible");
    cy.get("@rowB").contains("button", /^수정$/).click();
    cy.get("@rowB").find(".ssh-server-form").should("be.visible");
    // B의 폼에도, A의 줄에도 영수증이 남으면 안 된다.
    cy.get(".ssh-key-check").should("not.exist");
    cy.get("@rowB").find(".ssh-server-form .form-actions").contains("button", "취소").click();
  });
});
