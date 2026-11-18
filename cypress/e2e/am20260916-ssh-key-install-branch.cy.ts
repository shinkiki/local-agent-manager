// 원격접근: 설정 → 애드온 → SSH → 연결 서버 → 서버 줄의 [공개키 등록]·[터미널]
// 2026-09-15(7b653ad1)에 '공개키 등록' 갈래가 붙었고, 연결 서버가 키와 따로 저장되면서 두
// 버튼은 키 줄에서 서버 줄로 옮겨 갔다. 한 서버 줄이 기억하는 열린 창은 하나뿐이라, 두
// 버튼이 노출 조건을 같이 쓰면서도 서로를 밀어내야 한다. 등록 창을 연 채 터미널을 누르면
// 셸 창으로 바뀌어야 하고, 바뀐 뒤에도 안내 문구와 접속 버튼 라벨이 갈래에 맞게 따라와야
// 한다. 문구가 섞이면 사용자는 비밀번호를 치는 창과 자유 셸 창을 구분하지 못한다.
describe("SSH 서버 줄의 공개키 등록 갈래가 터미널 갈래와 배타적으로 열린다", () => {
  const base = `am-qa-install-${Date.now()}`;
  const pub = `${base}.pub`;
  const serverName = `qa-install-${Date.now()}`;

  before(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
    cy.createSshKey(base, "ssh-install-branch-test");
  });

  after(() => {
    cy.deleteSshServer(serverName);
    cy.deleteSshKey(pub);
  });

  it("키 줄에는 두 버튼이 없고, 서버를 추가하면 서버 줄에서 한 번에 한 갈래만 열린다", () => {
    // 1. 등록·터미널은 서버 단위다. 키 줄에는 두 갈래가 모두 노출되지 않아야 한다.
    cy.sshKeyRow(pub).contains("button", /^공개키 등록$/).should("not.exist");
    cy.sshKeyRow(pub).contains("button", /^터미널$/).should("not.exist");

    // 2. 이 키를 쓰는 서버를 추가한다. 창을 열기만 하고 접속은 누르지 않으므로 닿지 않는 포트면 된다.
    cy.addSshServer({ name: serverName, host: "127.0.0.1", user: "qauser", port: "1", keyPublicName: pub });
    cy.sshServerRow(serverName).as("row");

    // 3. 저장된 서버와 개인키가 있으므로 두 버튼이 함께 나타난다.
    cy.get("@row").contains("button", /^공개키 등록$/).should("be.visible");
    cy.get("@row").contains("button", /^터미널$/).should("be.visible");

    // 4. 등록 갈래를 연다. 접속 버튼과 바닥글이 등록 문구여야 한다.
    cy.get("@row").contains("button", /^공개키 등록$/).click();
    cy.get("@row").find(".ssh-key-terminal .terminal-panel").should("be.visible");
    cy.get("@row").find(".ssh-key-terminal footer").should("contain.text", "authorized_keys");
    cy.get("@row").find(".ssh-key-terminal footer").should("contain.text", "비밀번호는 저장되지 않음");
    cy.get("@row").find(".ssh-key-terminal").contains("button", /^등록$/).should("be.visible");
    // 버튼 라벨이 닫기로 뒤집히고, 반대 갈래 버튼은 열림 표시가 붙지 않은 채 그대로다.
    cy.get("@row").contains("button", "등록 닫기").should("be.visible");
    cy.get("@row").contains("button", /^터미널$/).should("be.visible");

    // 5. 등록 창을 연 채 터미널을 누르면 셸 갈래로 바뀐다. 두 창이 함께 열려 있으면 안 된다.
    cy.get("@row").contains("button", /^터미널$/).click();
    cy.get("@row").find(".ssh-key-terminal").should("have.length", 1);
    cy.get("@row").find(".ssh-key-terminal footer").should("contain.text", "명령 허용 목록은 적용되지 않음");
    cy.get("@row").find(".ssh-key-terminal footer").should("not.contain.text", "authorized_keys");
    cy.get("@row").find(".ssh-key-terminal").contains("button", /^접속$/).should("be.visible");
    cy.get("@row").contains("button", "터미널 닫기").should("be.visible");
    cy.get("@row").contains("button", /^공개키 등록$/).should("be.visible");

    // 6. 다시 등록 갈래로 돌아와도 같은 판단이 유지된다.
    cy.get("@row").contains("button", /^공개키 등록$/).click();
    cy.get("@row").find(".ssh-key-terminal").should("have.length", 1);
    cy.get("@row").find(".ssh-key-terminal footer").should("contain.text", "authorized_keys");
    cy.get("@row").contains("button", /^터미널$/).should("be.visible");

    // 7. 같은 버튼을 다시 누르면 창이 닫히고 어느 갈래도 열려 있지 않다.
    cy.get("@row").contains("button", "등록 닫기").click();
    cy.get("@row").find(".ssh-key-terminal").should("not.exist");
    cy.get("@row").contains("button", /^공개키 등록$/).should("be.visible");
    cy.get("@row").contains("button", /^터미널$/).should("be.visible");
  });
});
