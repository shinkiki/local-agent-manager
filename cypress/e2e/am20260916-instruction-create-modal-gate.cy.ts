// '새 지침 만들기' 모달이 무엇을 막고 무엇을 백엔드까지 보내는지 본다.
// 기존 지침 시나리오는 빈 라이브러리 툴바(AM-20), 배포 매트릭스·위치 표·지원 OS,
// 가져오기 문서 트리(AM-175), 휴지통 그룹(qa40), 다국어까지이고, 원본을 새로 만드는
// 모달 자체는 처음이다.
//
// 이 모달의 저장 게이트는 화면에만 있고(키 비움·공급자 0개·공급자 본문 공백 →
// 만들기 버튼 비활성, src/components/InstructionsView.tsx:3087), 키의 글자 규칙과
// 같은 키 중복은 백엔드가 본다
// (crates/agent-manager-core/src/project_instructions.rs:2233, :2396).
// 거절은 모달을 닫지 않고 모달 안에서 알려야 한다 — 닫아 버리면 방금 친 본문이
// 통째로 사라진다(같은 파일 :3039의 계약).

describe("새 지침 만들기 모달의 저장 게이트와 거절 안내", () => {
  const createButton = () => cy.get(".modal .modal-footer").contains("button", "지침 만들기");

  beforeEach(() => {
    cy.visitApp();
    cy.openInstructionMode("manage");
    cy.get(".skill-library-toolbar-row button").contains("새 지침").click();
    cy.get(".modal").should("be.visible");
  });

  it("키·공급자·본문이 갖춰질 때만 만들기가 열리고, 백엔드가 거절한 키는 모달 안에서 알린다", () => {
    // 1) 기본은 codex 한 공급자에 템플릿 본문이 차 있고, 키만 비어 있다.
    cy.get("#instruction-create-key").should("have.value", "");
    cy.get("#instruction-content-codex").invoke("val").should("not.be.empty");
    createButton().should("be.disabled");

    // 2) 키를 채우면 열린다.
    cy.get("#instruction-create-key").type("qa-gate-check");
    createButton().should("not.be.disabled");

    // 3) 본문을 공백만 남기면 다시 막힌다 — 빈 원본이 만들어지면 배포할 것이 없다.
    cy.get("#instruction-content-codex").clear().type("   ");
    createButton().should("be.disabled");
    cy.get("#instruction-content-codex").clear().type("# QA 게이트 확인용 지침");
    createButton().should("not.be.disabled");

    // 4) 공급자를 모두 끄면 쓸 파일이 없어 다시 막히고, 그 공급자의 본문 칸도 사라진다.
    cy.get(".modal .skill-use-matrix").last().find("input[type=checkbox]:checked").uncheck({ force: true });
    cy.get("#instruction-content-codex").should("not.exist");
    createButton().should("be.disabled");

    // 5) 다시 켜면 본문 칸이 돌아오고 아까 친 내용이 남아 있다.
    cy.get(".modal .skill-use-matrix").last().find("input[type=checkbox]").eq(1).check({ force: true });
    cy.get("#instruction-content-codex").should("have.value", "# QA 게이트 확인용 지침");
    createButton().should("not.be.disabled");

    // 6) 글자 규칙은 만들기 전에 칸 옆에 적혀 있다 — 한때 아무 데도 없어서 다 친 뒤에야
    //    백엔드 거절로 알게 됐다(QA #87). 규칙을 어긴 키는 여전히 백엔드가 최종 판정한다.
    cy.get(".modal").contains("영문·숫자·하이픈·밑줄만, 1~64자").should("be.visible");
    cy.get("#instruction-create-key").should("have.attr", "maxlength", "64");
    cy.get("#instruction-create-key").clear().type("qa gate check");
    createButton().should("not.be.disabled").click();

    // 7) 거절은 모달을 닫지 않고 모달 안 배너로 알린다. 친 본문도 그대로 남는다.
    cy.get(".modal .error-banner").should("contain.text", "지침 키에는 영문, 숫자, 하이픈, 밑줄만 사용할 수 있습니다");
    cy.get(".modal").should("be.visible");
    cy.get("#instruction-content-codex").should("have.value", "# QA 게이트 확인용 지침");
  });

  it("같은 키로 다시 만들면 충돌을 모달 안에서 알리고 먼저 만든 원본은 그대로 남는다", () => {
    cy.get("#instruction-create-key").type("qa-dup-key");
    cy.get("#instruction-create-name").type("QA 중복 키 확인");
    createButton().click();

    // 1) 성공하면 모달이 닫히고 목록에 나타난다.
    cy.get(".modal").should("not.exist");
    cy.get(".instructions-view").should("contain.text", "QA 중복 키 확인");

    // 2) 같은 키로 한 번 더 만든다.
    cy.get(".skill-library-toolbar-row button").contains("새 지침").click();
    cy.get(".modal").should("be.visible");
    cy.get("#instruction-create-key").type("qa-dup-key");
    createButton().click();

    // 3) 충돌 안내가 모달 안에 뜨고 모달은 열린 채 남는다.
    cy.get(".modal .error-banner").should("contain.text", "qa-dup-key").and("contain.text", "이미 있습니다");
    cy.get(".modal").should("be.visible");

    // 4) 취소하고 나와도 먼저 만든 원본은 한 건 그대로다.
    cy.get(".modal .modal-footer").contains("button", "취소").click();
    cy.get(".modal").should("not.exist");
    cy.get(".instructions-view").should("contain.text", "QA 중복 키 확인");
    cy.get(".skill-library-summary small").invoke("text").should("match", /^1개 · /);
  });
});
