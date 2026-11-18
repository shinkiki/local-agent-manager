// AM-28 (임시 스펙): 애드온 → Cypress의 작업공간 추가 폼에서
// 필수값 경계(이름·폴더 trim)와, 취소로 닫은 뒤 다시 열었을 때 입력값이 어떻게 되는지,
// 화면 전환·새로고침이 폼 상태를 어떻게 다루는지.
// 등록은 실제로 누르지 않는다 — 파일시스템에 폴더를 만들지 않기 위해서다.
describe("Cypress 작업공간 추가 폼의 필수값 경계와 폼 상태 수명", () => {
  const openAutomation = () => {
    cy.openAddonsView("cypress");
  };

  const openForm = () => {
    cy.contains(".settings-subsection header button", "작업공간 추가").click();
    cy.get(".cypress-form").should("be.visible");
  };

  // .cypress-form-actions는 패널 안에 세 벌 있으므로(등록 폼·설정 편집기·환경값 편집기)
  // 반드시 등록 폼 안으로 좁혀 잡는다.
  const submitButton = () => cy.get(".cypress-form .cypress-form-actions button.primary");

  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    openAutomation();
  });

  it("기본 작업공간 없이 시작하고 추가 버튼이 눌리는 상태다", () => {
    cy.get(".cypress-panel").should("not.contain.text", "작업공간을 불러오는 중…");
    cy.get(".cypress-panel").should("contain.text", "등록된 작업공간이 없습니다.");
    cy.contains(".settings-subsection header button", "작업공간 추가").should("not.be.disabled");
  });

  it("이름·폴더가 비었거나 공백뿐이면 등록이 막히고 둘 다 채워야 열린다", () => {
    openForm();
    submitButton().should("be.disabled");

    // 공백만으로는 열리지 않는다(trim 경계).
    cy.get("#cypress-new-name").type("   ");
    cy.get("#cypress-new-path").type("   ");
    submitButton().should("be.disabled");

    // 이름만 유효한 경우.
    cy.get("#cypress-new-name").clear().type("QA 임시 작업공간");
    submitButton().should("be.disabled");

    // 폴더만 유효한 경우.
    cy.get("#cypress-new-name").clear();
    cy.get("#cypress-new-path").clear().type("/tmp/am-qa-not-created");
    submitButton().should("be.disabled");

    // 둘 다 유효할 때만 활성된다.
    cy.get("#cypress-new-name").type("QA 임시 작업공간");
    submitButton().should("not.be.disabled");

    // Cypress 모듈 위치는 선택 항목이라 비어 있어도 등록을 막지 않는다.
    cy.get("#cypress-new-module").should("have.value", "");
    submitButton().should("not.be.disabled");
  });

  it("취소로 닫아도 입력값은 지역 상태에 남아 다시 열면 그대로 보인다", () => {
    openForm();
    cy.get("#cypress-new-name").type("QA 임시 작업공간");
    cy.get("#cypress-new-path").type("/tmp/am-qa-not-created");

    cy.contains(".cypress-form .cypress-form-actions button", "취소").click();
    cy.get(".cypress-form").should("not.exist");

    openForm();
    cy.get("#cypress-new-name").should("have.value", "QA 임시 작업공간");
    cy.get("#cypress-new-path").should("have.value", "/tmp/am-qa-not-created");
  });

  it("화면 전환 뒤에는 폼이 유지되고 새로고침 뒤에는 초기화된다", () => {
    openForm();
    cy.get("#cypress-new-name").type("QA 임시 작업공간");

    // 화면은 계속 마운트되므로 지역 상태가 살아 있다(스킬 검색어 AM-14와 같은 계약).
    cy.revisitView("addons");
    cy.anchor("addons.cypress-content").should("be.visible");
    cy.get(".cypress-form").should("be.visible");
    cy.get("#cypress-new-name").should("have.value", "QA 임시 작업공간");

    // 폼 상태에는 localStorage 저장 계약이 없으므로 새로고침이면 사라진다.
    cy.reload();
    cy.anchor("nav.sessions").should("be.visible");
    openAutomation();
    cy.get(".cypress-form").should("not.exist");
    openForm();
    cy.get("#cypress-new-name").should("have.value", "");
    cy.get("#cypress-new-path").should("have.value", "");
  });
});
