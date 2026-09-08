/// <reference types="cypress" />
// AM-135
// 애드온 → 아이아 → 'QA 워크플로 온보딩' 목업의 다국어 전환 계약.
// 목업의 입력 껍데기 열두 벌과 체크박스 묶음 두 벌이 MockField·MockTextField·MockChoiceGroup
// 한 벌로 모였다(src/components/AddonsView.tsx:261, :271, :295). 이름표는 언제나 두 벌이지만
// 자리글은 갈린다 — `placeholderEn`을 준 칸만 번역되고, 저장소 경로·개발서버 주소처럼
// 번역이 없는 칸은 영어에서도 같은 글자를 그대로 낸다(:284의 `placeholderEn === undefined` 갈림).
// 한쪽으로 뭉뚱그려 text(ko, en)을 태우면 `~/gsProjects/<system>`이 한국어 자리글로 취급돼
// 영어에서 빈 자리글이 되거나 경로가 번역돼 사라진다.
//
// 기존 am20260906-addons-aia-onboarding-steps.cy.ts는 같은 목업의 단계 이동 경계와 값 잔존만
// 본다(한국어). 여기서 새로 보는 축은 다국어 전환이며, 함께 붙잡는 것은 껍데기가 한 벌로
// 모이면서 흔들리기 쉬운 두 가지다: 넓은 칸(`wide`)이 붙는 자리와 체크박스 묶음의 초기 켬 개수
// (계정 역할은 앞 3개만, 검증 축은 전부 — :345, :357).

const AIA = '[data-ui-anchor="addons.aia-content"]';

function openOnboarding(): void {
  cy.visitApp();
  cy.openView("addons").should("be.visible");
  cy.anchor("addons.aia-content").should("be.visible");
  cy.get(AIA).contains("button", "Start onboarding").click();
  cy.get(`${AIA} [aria-current="step"]`).should("exist");
}

function next(): void {
  cy.get(AIA).contains("button", "Next").click();
}

/** 목업 입력 영역의 이름표 글자 목록. 껍데기가 label 안 첫 span이라 순서가 곧 화면 순서다. */
function fieldLabels() {
  return cy.get(`${AIA} .aia-onboarding-fields > label > span, ${AIA} .aia-onboarding-fields > div.wide > span`);
}

describe("아이아 QA 온보딩 목업의 영어 전환 계약", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.setLanguage("en");
    openOnboarding();
  });

  // 이 스펙은 영어로 바꾼 채 끝나므로 반드시 한국어로 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  it("1단계 이름표는 모두 영어이고, 번역이 없는 경로·주소 자리글은 영어에서도 그대로 남는다", () => {
    fieldLabels().should("have.length", 4);
    fieldLabels().eq(0).should("have.text", "System name");
    fieldLabels().eq(1).should("have.text", "Business areas");
    fieldLabels().eq(2).should("have.text", "Repository path");
    fieldLabels().eq(3).should("have.text", "Dev server URL");

    // 번역이 있는 칸은 영어 자리글로 바뀐다.
    cy.get(`${AIA} .aia-onboarding-fields input[type=text]`).eq(0)
      .should("have.attr", "placeholder", "e.g. HR portal");

    // 번역이 없는 칸은 한국어에서 본 글자와 완전히 같아야 한다. 비어 버리면 사용자는
    // 무엇을 넣어야 하는 칸인지 알 수 없다.
    cy.get(`${AIA} .aia-onboarding-fields input[type=text]`).eq(2)
      .should("have.attr", "placeholder", "~/gsProjects/<system>");
    cy.get(`${AIA} .aia-onboarding-fields input[type=text]`).eq(3)
      .should("have.attr", "placeholder", "https://dev.example.com");
  });

  it("1단계에서 넓은 칸은 경로·주소 두 칸뿐이고 앞의 두 칸에는 wide가 붙지 않는다", () => {
    cy.get(`${AIA} .aia-onboarding-fields > label`).eq(0).should("not.have.class", "wide");
    cy.get(`${AIA} .aia-onboarding-fields > label`).eq(1).should("not.have.class", "wide");
    cy.get(`${AIA} .aia-onboarding-fields > label`).eq(2).should("have.class", "wide");
    cy.get(`${AIA} .aia-onboarding-fields > label`).eq(3).should("have.class", "wide");
  });

  it("2단계 계정 역할 묶음은 영어 선택지 다섯 개 중 앞 세 개만 켠 채로 시작한다", () => {
    next();
    cy.get(`${AIA} [aria-current="step"]`).should("contain.text", "Test environment");
    cy.get(`${AIA} .aia-onboarding-choices label`).should("have.length", 5);
    cy.get(`${AIA} .aia-onboarding-choices label`).eq(0).should("have.text", "Drafter");
    cy.get(`${AIA} .aia-onboarding-choices label`).eq(4).should("have.text", "Outsider (authz check)");
    cy.get(`${AIA} .aia-onboarding-choices input[type=checkbox]`).each(($box, index) => {
      expect($box.is(":checked"), `option ${index}`).to.eq(index < 3);
    });
  });

  it("3단계 검증 축 묶음은 영어 선택지 네 개가 모두 켜진 채로 시작한다", () => {
    next();
    next();
    cy.get(`${AIA} .aia-onboarding-choices label`).should("have.length", 4);
    cy.get(`${AIA} .aia-onboarding-choices label`).eq(0).should("have.text", "Input, popups, grids");
    cy.get(`${AIA} .aia-onboarding-choices label`).eq(3).should("have.text", "Change-history diff");
    cy.get(`${AIA} .aia-onboarding-choices input[type=checkbox]:checked`).should("have.length", 4);
  });
});
