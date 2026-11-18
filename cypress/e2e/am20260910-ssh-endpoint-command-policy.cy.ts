// 원격접근: 설정 → 애드온 → SSH → 연결 서버 → [서버 추가]·[수정]의 고급 설정
// 백엔드가 준 허용/차단 기본 명령 정책이 새 서버 폼에 올바르게 로드되는지 확인하고,
// 임의 편집 후 '기본값으로' 초기화 버튼 동작, 공백 라인 정규화 저장, 서버 삭제를 검증한다.
// 연결 서버는 키와 따로 저장되는 목록이라(키 행의 연결 서버 편집은 없어졌다) 서버 줄에서 본다.
describe("SSH 연결 서버 명령 정책의 기본값 복원과 저장·삭제 계약", () => {
  const fileBase = `am-qa-policy-${Date.now()}`;
  const publicName = `${fileBase}.pub`;
  const serverName = `qa-policy-${Date.now()}`;

  before(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
    cy.createSshKey(fileBase, "ssh-policy-test");
  });

  after(() => {
    cy.deleteSshKey(publicName);
  });

  it("새 서버 폼에서 기본 명령 정책을 제공하고 편집 후 '기본값으로' 복원 및 저장이 정상 동작한다", () => {
    // 1. 서버 추가 폼 열기
    cy.contains(".ssh-section-head button", "서버 추가").click();
    cy.get(".ssh-server-new .ssh-server-form").as("form").should("be.visible");

    // 이름·주소·사용자·인증키 입력
    cy.get("#ssh-server-name-new").type(serverName);
    cy.get("#ssh-server-host-new").type("test.remote.io");
    cy.get("#ssh-server-user-new").type("opsuser");
    cy.selectSshServerKey(".ssh-server-new", publicName);

    // 2. 고급 설정(명령 목록) details 펼치기
    cy.get("@form").find("details.ssh-key-advanced").as("advanced");
    cy.get("@advanced").find("summary").click();
    cy.get("@advanced").should("have.attr", "open");

    // 초기 차단 명령 기본값 확인 (백엔드 기본값 예: rm -rf, mkfs 등 존재)
    cy.get("#ssh-server-deny-new").as("denyInput");
    cy.get("@denyInput").invoke("val").should("not.be.empty");
    cy.get("@denyInput").invoke("val").then((initialDeny) => {
      // 3. 차단 명령을 수정하고 '기본값으로' 버튼을 눌러 복원되는지 확인
      cy.get("@denyInput").clear().type("custom_dangerous_command\n\n");
      cy.get("@denyInput").should("have.value", "custom_dangerous_command\n\n");

      cy.get("@advanced").contains("button", "기본값으로").click();
      cy.get("@denyInput").invoke("val").should("eq", initialDeny);
    });

    // 4. 허용 명령에 공백 라인이 섞인 정책 입력
    cy.get("#ssh-server-allow-new").clear().type("git status\n  \n uptime \n\n");

    // 추가 버튼 클릭 — 새 서버 폼은 닫히고 목록에 줄이 생긴다.
    cy.contains(".ssh-server-new .form-actions button.primary", "추가").click();
    cy.get(".ssh-server-new").should("not.exist");

    // 5. 요약 배지와 쓰는 키 확인
    cy.sshServerRow(serverName).as("serverRow");
    cy.get("@serverRow").find(".ssh-key-endpoint").should("contain.text", "opsuser@test.remote.io:22");
    cy.get("@serverRow").find(".ssh-server-key").should("contain.text", publicName);
    // 키 줄에도 이 키를 쓰는 서버 이름이 붙는다.
    cy.sshKeyRow(publicName).find(".ssh-key-servers").should("contain.text", serverName);

    // '수정'으로 다시 열기
    cy.get("@serverRow").contains("button", /^수정$/).click();
    cy.get("@serverRow").find(".ssh-server-form").should("be.visible");
    cy.get("@serverRow").find("details.ssh-key-advanced summary").click();

    // 빈 줄이 정규화되어 저장되었는지 확인
    cy.get("@serverRow").find("textarea[id^='ssh-server-allow-']").invoke("val").should("eq", "git status\nuptime");
    // 저장본과 같으므로 저장은 잠겨 있다.
    cy.get("@serverRow").contains(".form-actions button.primary", "저장").should("be.disabled");

    // 취소로 닫는다.
    cy.get("@serverRow").find(".ssh-server-form .form-actions").contains("button", "취소").click();
    cy.get("@serverRow").find(".ssh-server-form").should("not.exist");

    // 6. 서버 삭제 — 키는 그대로 남는다.
    cy.deleteSshServer(serverName);
    cy.sshKeyRow(publicName).should("be.visible").find(".ssh-key-servers").should("not.exist");
  });
});
