// AM-37 (임시 스펙): 설정 → 애드온 → SSH의 'SSH 키 생성' 폼.
// 임시 HOME이라 ~/.ssh 공개키가 0건인 빈 상태에서 시작해, 파일 이름 필수값 경계와
// 설명 120자 경계, 키 종류 기본값·암호 확인 불일치, 취소 후 재개방·화면 전환·새로고침이
// 폼 상태를 어떻게 다루는지 본다.
// '생성'은 실제로 누르지 않는다 — 임시 HOME이라도 키 파일을 만들지 않기 위해서다.
describe("SSH 키 생성 폼의 필수값·설명 길이 경계와 폼 상태 수명", () => {
  const openSsh = () => cy.openSshKeysTab();
  const openForm = () => cy.openSshKeyForm();

  const submitButton = () => cy.get(".ssh-key-form .form-actions button.primary");

  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    openSsh();
  });

  it("공개키 0건 빈 상태에서도 키 생성 수단이 눌리는 상태로 열려 있다", () => {
    cy.get(".ssh-key-empty").should("contain.text", "확인된 공개키가 없습니다");
    cy.get(".ssh-key-list").should("not.exist");
    // 빈 상태여도 키 폴더 경로와 새로고침은 보여야 한다.
    cy.get(".ssh-key-location code").should("not.have.text", "");
    cy.contains(".ssh-keys-card .settings-update-body button", "키 생성").should("not.be.disabled");
  });

  it("폼은 기본 파일 이름·설명이 채워진 채 열리고, 파일 이름이 공백뿐이면 생성이 막힌다", () => {
    openForm();
    cy.get("#ssh-key-file-name").should("have.value", "id_agent_manager");
    cy.get("#ssh-key-comment").should("have.value", "agent-manager");
    submitButton().should("not.be.disabled");

    // 빈 값과 공백만 — 둘 다 trim 경계에서 막혀야 한다.
    cy.get("#ssh-key-file-name").clear();
    submitButton().should("be.disabled");
    cy.get("#ssh-key-file-name").type("   ");
    submitButton().should("be.disabled");

    // 설명은 비어도 생성을 막지 않는다(선택 항목).
    cy.get("#ssh-key-file-name").clear().type("am-qa-key");
    cy.get("#ssh-key-comment").clear();
    submitButton().should("not.be.disabled");
  });

  it("키 종류는 백엔드 목록의 첫 항목(Ed25519)이 기본이고, 암호 확인이 다르면 생성이 막힌다", () => {
    openForm();
    cy.get("#ssh-key-type").should("have.value", "ed25519");
    cy.get("#ssh-key-type option").should("have.length.greaterThan", 1);
    cy.get("#ssh-key-type option").first().should("have.value", "ed25519");

    // 암호는 선택 항목이다. 비어 있으면 확인 칸은 잠겨 있고 생성은 열려 있다.
    cy.get("#ssh-key-passphrase").should("have.attr", "type", "password").and("have.value", "");
    cy.get("#ssh-key-passphrase-confirm").should("be.disabled");
    submitButton().should("not.be.disabled");

    // 암호만 적고 확인을 비우면 불일치로 막히고, 같은 값을 적으면 풀린다.
    cy.get("#ssh-key-passphrase").type("qa-secret-1");
    cy.get(".ssh-key-passphrase-mismatch").should("contain.text", "두 암호가 다릅니다");
    submitButton().should("be.disabled");
    cy.get("#ssh-key-passphrase-confirm").type("qa-secret-2");
    submitButton().should("be.disabled");
    cy.get("#ssh-key-passphrase-confirm").clear().type("qa-secret-1");
    cy.get(".ssh-key-passphrase-mismatch").should("not.exist");
    submitButton().should("not.be.disabled");

    // 취소하면 암호는 지워진다 — 파일 이름·설명과 달리 닫힌 폼에 남겨 둘 값이 아니다.
    cy.contains(".ssh-key-form .form-actions button", "취소").click();
    openForm();
    cy.get("#ssh-key-passphrase").should("have.value", "");
    cy.get("#ssh-key-passphrase-confirm").should("have.value", "");
  });

  it("설명은 120자에서 더 들어가지 않고 글자수를 함께 알린다", () => {
    openForm();
    // 한도를 넘겨 생성 버튼이 조용히 죽던 자리(QA #12). 이제 입력이 120에서 멈추고
    // 글자수/한도가 칸 아래에 함께 보이므로, 막힌 이유를 폼 안에서 읽을 수 있다.
    cy.get("#ssh-key-comment").clear().type("c".repeat(120), { delay: 0 });
    cy.get(".ssh-key-comment-field small").should("have.text", "120/120자");
    submitButton().should("not.be.disabled");

    cy.get("#ssh-key-comment").type("c", { delay: 0 });
    cy.get("#ssh-key-comment").should("have.value", "c".repeat(120));
    submitButton().should("not.be.disabled");

    cy.get("#ssh-key-comment").type("{backspace}");
    cy.get(".ssh-key-comment-field small").should("have.text", "119/120자");
    submitButton().should("not.be.disabled");
  });

  it("취소로 닫아도 입력값은 지역 상태에 남아 다시 열면 그대로 보인다", () => {
    openForm();
    cy.get("#ssh-key-file-name").clear().type("am-qa-key");
    cy.get("#ssh-key-comment").clear().type("qa-note");
    cy.contains(".ssh-key-form .form-actions button", "취소").click();
    cy.get(".ssh-key-form").should("not.exist");

    openForm();
    cy.get("#ssh-key-file-name").should("have.value", "am-qa-key");
    cy.get("#ssh-key-comment").should("have.value", "qa-note");
  });

  // 다른 화면으로 갔다 와도 설정 화면은 마운트된 채라 폼이 열린 상태와 입력값이 함께
  // 남는다. Cypress 작업공간 등록 폼(AM-28)과 같은 계약이며, 되돌리는 경계는 새로고침이다.
  it("다른 화면으로 갔다 와도 열린 폼과 입력값이 그대로 남는다", () => {
    openForm();
    cy.get("#ssh-key-file-name").clear().type("am-qa-key");

    cy.anchor("nav.sessions").click();
    openSsh();

    cy.get(".ssh-key-form").should("be.visible");
    cy.get("#ssh-key-file-name").should("have.value", "am-qa-key");
  });

  it("새로고침하면 SSH 탭 선택은 남아도 폼은 남지 않는다", () => {
    openForm();
    cy.get("#ssh-key-file-name").clear().type("am-qa-key");
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openView("addons").should("be.visible");
    // 애드온 탭은 저장값으로 복원되지만(AM-116), 작성 중이던 폼은 화면이 다시 그려지며 사라진다.
    cy.anchor("addons.tab.ssh").should("have.attr", "aria-selected", "true");
    cy.get(".ssh-key-form").should("not.exist");
  });
});
