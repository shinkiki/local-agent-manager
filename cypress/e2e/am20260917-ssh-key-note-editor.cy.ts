// 원격접근: 설정 → 애드온 → SSH → SSH 접속정보관리 → 키 행의 [메모]
// 키 메모는 기기 로컬에만 저장되고 .pub 파일은 건드리지 않는다. 버튼 라벨이 메모 유무로
// 갈리고(메모/메모 편집), 저장 버튼은 초안이 저장본과 같으면 잠기며 비우면 '메모 지우기'로
// 뒤집힌다. 여기에 한 행은 메모와 암호 상자 중 하나만 펴는 것이 설계 의도다
// (src/components/SshKeysCard.tsx의 useSshKeyRowEditors — 두 상자가 같은 줄을 겹쳐 쓴다).
// 연결 서버 편집은 키 줄에서 서버 줄로 옮겨 가, 키 줄에서 배타성을 지킬 짝은 이제 암호 상자다.
// 이 회차는 라벨 뒤집힘·초안 폐기·글자수 표시와 두 상자의 배타성을 함께 본다.
describe("SSH 키 메모 편집기의 라벨 뒤집힘과 초안 폐기", () => {
  const fileBase = `am-qa-note-${Date.now()}`;
  const publicName = `${fileBase}.pub`;

  before(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
    cy.createSshKey(fileBase, "ssh-note-test");
  });

  // 테스트 사이에 페이지가 초기화되므로 매번 SSH 탭으로 되돌아간다.
  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
  });

  after(() => {
    cy.deleteSshKey(publicName);
  });

  it("메모가 없으면 '메모', 저장 뒤에는 '메모 편집'이며 초안은 취소로 버려진다", () => {
    cy.sshKeyRow(publicName).as("row");

    // 1. 메모가 없는 키는 버튼이 '메모'이고 행에 메모 줄이 없다.
    cy.get("@row").contains("button", /^메모$/).should("be.visible");
    cy.get("@row").find(".ssh-key-note").should("not.exist");

    // 2. 폼을 연다. 초안이 저장본(빈 값)과 같으므로 저장 버튼은 잠겨 있고 라벨은 '메모 지우기'다.
    cy.get("@row").contains("button", /^메모$/).click();
    cy.get("@row").find(".ssh-key-note-form").should("be.visible");
    cy.get("@row").find(".ssh-key-note-form .form-actions small").should("contain.text", "0/300");
    cy.get("@row").find(".ssh-key-note-form").contains("button", "메모 지우기").should("be.disabled");

    // 3. 초안을 적으면 저장이 열리고 글자수가 따라온다. 공백만 친 초안은 다시 잠긴다.
    cy.get("@row").find(".ssh-key-note-form textarea").type("   ");
    cy.get("@row").find(".ssh-key-note-form .form-actions small").should("contain.text", "0/300");
    cy.get("@row").find(".ssh-key-note-form").contains("button", "메모 지우기").should("be.disabled");
    cy.get("@row").find(".ssh-key-note-form textarea").clear().type("빌드 서버 배포용");
    cy.get("@row").find(".ssh-key-note-form .form-actions small").should("contain.text", "9/300");
    cy.get("@row").find(".ssh-key-note-form").contains("button", /^저장$/).should("not.be.disabled");

    // 4. 취소하면 초안은 버려지고 행에도 메모가 남지 않는다.
    cy.get("@row").find(".ssh-key-note-form").contains("button", "취소").click();
    cy.get("@row").find(".ssh-key-note-form").should("not.exist");
    cy.get("@row").find(".ssh-key-note").should("not.exist");
    cy.get("@row").contains("button", /^메모$/).click();
    cy.get("@row").find(".ssh-key-note-form textarea").should("have.value", "");

    // 5. 다시 적어 저장하면 행에 메모 줄이 붙고 버튼이 '메모 편집'으로 뒤집힌다.
    cy.get("@row").find(".ssh-key-note-form textarea").type("  빌드 서버 배포용  ");
    cy.get("@row").find(".ssh-key-note-form").contains("button", /^저장$/).click();
    cy.get("@row").find(".ssh-key-note-form").should("not.exist");
    // 앞뒤 공백은 다듬어 저장한다.
    cy.get("@row").find(".ssh-key-note").should("have.text", "빌드 서버 배포용");
    cy.get("@row").contains("button", "메모 편집").should("be.visible");

    // 6. 편집 폼은 저장본을 초안으로 싣고, 같은 값이면 저장이 잠긴다.
    cy.get("@row").contains("button", "메모 편집").click();
    cy.get("@row").find(".ssh-key-note-form textarea").should("have.value", "빌드 서버 배포용");
    cy.get("@row").find(".ssh-key-note-form").contains("button", /^저장$/).should("be.disabled");
    // 편집 중에는 행의 메모 줄이 겹쳐 보이지 않는다.
    cy.get("@row").find(".ssh-key-note").should("not.exist");

    // 7. 비우면 '메모 지우기'로 뒤집히고, 눌러야 메모가 사라진다.
    cy.get("@row").find(".ssh-key-note-form textarea").clear();
    cy.get("@row").find(".ssh-key-note-form").contains("button", "메모 지우기").should("not.be.disabled").click();
    cy.get("@row").find(".ssh-key-note-form").should("not.exist");
    cy.get("@row").find(".ssh-key-note").should("not.exist");
    cy.get("@row").contains("button", /^메모$/).should("be.visible");
  });

  it("한 행에서 메모와 암호 상자는 어느 방향으로 눌러도 하나만 열린다(AM-365)", () => {
    cy.sshKeyRow(publicName).as("row");

    // 1. 메모를 편 상태에서 암호 저장을 누르면 메모가 닫힌다.
    cy.get("@row").contains("button", /^메모$/).click();
    cy.get("@row").find(".ssh-key-note-form").should("be.visible");
    cy.get("@row").contains("button", "암호 저장").click();
    cy.get("@row").find(".ssh-key-passphrase-form").should("be.visible");
    cy.get("@row").find(".ssh-key-note-form").should("not.exist");
    // 암호 칸은 언제나 빈 칸의 password 입력이다 — 저장된 암호는 화면으로 오지 않는다.
    cy.get("@row").find(".ssh-key-passphrase-form input").should("have.attr", "type", "password").and("have.value", "");
    cy.get("@row").find(".ssh-key-passphrase-form").contains("button", "암호 저장").should("be.disabled");

    // 2. 반대 방향도 같다. 암호 상자를 편 채 메모를 누르면 암호 상자가 닫힌다 —
    //    한때 한 방향만 막혀 있어 두 폼이 한 행에 겹쳐 쌓였다(QA #90).
    cy.get("@row").contains("button", /^메모$/).click();
    cy.get("@row").find(".ssh-key-note-form").should("be.visible");
    cy.get("@row").find(".ssh-key-passphrase-form").should("not.exist");

    cy.get("@row").find(".ssh-key-note-form").contains("button", "취소").click();
  });
});
