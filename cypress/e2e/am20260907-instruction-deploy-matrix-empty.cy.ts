/// <reference types="cypress" />
// AM-133. 지침 배포 매트릭스(2단계 "위치별 배포")의 프로젝트 0곳 계약. 같은 날 커밋
// 245f6f6의 am20260907-instruction-location-matrix는 프로젝트 목록을 심어 두고 기본 노출·
// 더보기·검색을 보지만, 등록 프로젝트가 하나도 없는 실제 초기 상태는 다루지 않는다.
// 여기서는 개인 설정 행 하나만 나오고 검색 입력과 "더 보기"·"배포된 곳만 보기"가 모두
// 뜨지 않으며, 열이 만들 때 고른 공급자뿐인 것을 붙잡는다(InstructionsView.tsx:511/545/556).
const MODE_KEY = "agent-manager.instruction-mode.v1";
// 격리 백엔드는 스펙 안에서 상태를 이어 가므로 키가 겹치면 두 번째 만들기가 거절된다.
let seq = 0;
let createdKey: string | null = null;

function createInstruction() {
  const key = `qa-deploy-matrix-${++seq}`;
  createdKey = key;
  cy.get(".skill-library-toolbar-row button").contains("새 지침").click();
  cy.get("#instruction-create-key").type(key);
  cy.get(".modal button").contains("지침 만들기").should("not.be.disabled").click();
  // 만들기가 실패하면 모달이 열린 채 사유만 바뀐다. 사유를 먼저 드러내고 닫힘을 기다린다.
  cy.get(".modal .error-banner").should("not.exist");
  cy.get("#instruction-create-key").should("not.exist");
  cy.get(".skill-library-row").contains(key).click();
}

function openDeployStep() {
  cy.get("#instruction-tab-2").click().should("have.attr", "aria-selected", "true");
}

describe("지침 배포 매트릭스 — 등록 프로젝트가 없을 때", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.window().its("localStorage").invoke("setItem", MODE_KEY, "manage");
    cy.openInstructionMode("manage");
  });

  afterEach(() => {
    if (createdKey === null) return;
    const key = createdKey;
    createdKey = null;
    // 하네스 백엔드는 스펙 사이에도 살아 있으므로 여기서 만든 원본을 바로 치워야 뒤의
    // 빈 라이브러리 스펙이 실제 초기 상태를 본다. 요청은 cy.intercept 스텁을 우회한다.
    cy.request("POST", "/api/invoke/delete_shared_project_instruction", {
      request: { key, deletedBy: "user", confirm: true },
    });
  });

  it("개인 설정 행 하나만 내고, 열은 만들 때 고른 공급자뿐이다", () => {
    createInstruction();
    openDeployStep();
    cy.get(".skill-location-matrix thead th").should("have.length", 2);
    cy.get(".skill-location-matrix thead th").eq(0).should("have.text", "위치");
    cy.get(".skill-location-matrix thead th").eq(1).should("have.text", "Codex");
    cy.get(".skill-location-matrix tbody tr").should("have.length", 1);
    cy.get(".skill-location-matrix tbody tr td").eq(0)
      .should("have.text", "개인 설정")
      .and("have.attr", "title", "공급자 홈 설정 디렉터리(~/.claude, ~/.codex, ~/.gemini)");
  });

  it("프로젝트가 5곳을 넘지 않으므로 검색 입력도, 펼침·접기 버튼도 없다", () => {
    createInstruction();
    openDeployStep();
    cy.get(".instruction-location-toolbar input.search-input").should("not.exist");
    cy.get(".instruction-location-toolbar button").should("have.length", 0);
    cy.contains(".prose-copy", "검색과 맞는 프로젝트가 없습니다.").should("not.exist");
  });

  it("개인 설정 행의 배포 토글은 아직 켜져 있지 않다", () => {
    createInstruction();
    openDeployStep();
    cy.get(".skill-location-matrix tbody tr td .skill-use-toggle input[type=checkbox]")
      .should("have.length", 1)
      .and("not.be.checked");
    cy.get(".skill-location-matrix tbody tr td .skill-use-toggle").should("not.have.class", "used");
  });
});
