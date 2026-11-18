// 워크플로 → 페이싱 탭의 사용량 예산 패널이 여는 편집 모달 세 갈래(예산 기본값·페이싱
// 스케줄·계정 풀)가 서로 배타적으로만 뜨는지, 저장하지 않고 닫은 초안이 다시 열 때
// 저장본으로 되돌아오는지를 본다.
// 기존 페이싱 스펙들은 카드의 빈 상태(am41)·기본값 숫자 경계(qa56)·페이싱 스위치·
// 제한 시간대 경계처럼 모달 '안'의 값만 다뤘고, 모달을 갈아 가며 여는 전환 자체와
// 미저장 초안의 잔존 여부는 이번이 처음이다. 다섯 모달의 열림 상태가 하나로 합쳐진
// 뒤(4d37f2a1)라 "하나만 열린다"와 "열 때 초안을 되돌린다"가 같은 자리에서 정해진다.
function panel() {
  return cy.anchor("workflows.usage-budget");
}

function openDefaults() {
  panel().find("header").contains("button", "예산 기본값").click();
}

function openPool() {
  cy.anchor("workflows.usage-budget.accounts").find('[aria-label="계정 풀 설정"]').click();
}

function modalTitle() {
  return cy.get(".modal-backdrop .modal-title");
}

function targetInput() {
  return cy.get(".modal-backdrop").contains("label", "목표 사용률(%)").find("input");
}

describe("사용량 예산 패널의 편집 모달 전환과 미저장 초안", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openPacingTab();
    panel().should("be.visible");
  });

  it("세 모달은 한 번에 하나만 뜨고, 앞서 연 모달은 열려 있지 않다", () => {
    // 1) 예산 기본값 하나만 열린다.
    openDefaults();
    cy.get(".modal-backdrop").should("have.length", 1);
    modalTitle().should("have.text", "예산 기본값");

    // 2) 닫고 스케줄을 열면 스케줄 하나만 남는다.
    cy.get(".modal-backdrop").contains("button", "닫기").click();
    cy.get(".modal-backdrop").should("not.exist");
    cy.anchor("workflows.usage-budget.schedule").click();
    cy.get(".modal-backdrop").should("have.length", 1);
    modalTitle().should("have.text", "페이싱 스케줄");

    // 3) Esc로 닫고 계정 풀을 열면 계정 풀 하나만 남는다 — 앞선 두 모달은 남지 않는다.
    cy.get("body").type("{esc}");
    cy.get(".modal-backdrop").should("not.exist");
    openPool();
    cy.get(".modal-backdrop").should("have.length", 1);
    modalTitle().should("have.text", "계정 풀 설정");
    cy.get(".modal-backdrop").should("not.contain.text", "예산 기본값");

    // 4) 닫으면 패널만 남고 오류 배너는 뜨지 않는다.
    cy.get('.modal-backdrop [aria-label="닫기"]').click();
    cy.get(".modal-backdrop").should("not.exist");
    panel().find(".error-banner").should("not.exist");
  });

  it("저장하지 않고 닫은 예산 기본값 초안은 다시 열 때 저장본으로 되돌아온다", () => {
    openDefaults();
    targetInput().invoke("val").then((saved) => {
      const kept = String(saved ?? "");

      // 5) 저장본과 다른 값으로 고친 뒤 저장하지 않고 닫는다.
      targetInput().clear().type("37").should("have.value", "37");
      cy.get(".modal-backdrop").contains("button", "닫기").click();
      cy.get(".modal-backdrop").should("not.exist");

      // 6) 패널 요약은 고친 초안이 아니라 저장본을 그대로 읽는다.
      panel().should("not.contain.text", "37%");

      // 7) 다시 열면 방금 친 37이 아니라 저장본이 보인다.
      openDefaults();
      targetInput().should("have.value", kept);
    });
  });
});
