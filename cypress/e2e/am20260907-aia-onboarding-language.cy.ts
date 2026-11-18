/// <reference types="cypress" />
// AM-135
// 워크플로 → 자동화 → 'QA 워크플로 온보딩' 카드의 다국어 전환 계약.
// 카드는 팩(W6)이 그리는 선언형 카드가 되었다(c9de7c43). 이름표·자리글·선택지는 모두 팩이
// `{ ko, en }` 한 쌍으로 들고 와 `localized`로 한 벌만 고른다. 한쪽으로 뭉뚱그려 한국어를
// 그대로 흘리면 영어 화면에 한글이 남고, 반대로 번역을 잃으면 칸이 빈 자리글이 된다.
// 필수 칸 이름표 뒤의 ` *` 표시는 언어와 무관하게 앱이 붙인다.
//
// am20260906-addons-aia-onboarding-steps.cy.ts는 같은 카드의 단계 이동 경계와 값 잔존만
// 본다(한국어). 여기서 새로 보는 축은 다국어 전환이며, 함께 붙잡는 것은 선언형으로 옮기며
// 흔들리기 쉬운 두 가지다: 넓은 칸(`wide`)이 붙는 자리와 체크박스 묶음의 초기 켬 상태
// (계정 역할은 팩 기본값 세 개, 검증 축은 여덟 중 네 개).

// 모듈로 두어 다른 스펙의 같은 이름 상수(AIA 등)와 전역에서 부딪히지 않게 한다.
export {};

const AIA = '[data-ui-anchor="workflows.automation-content"]';
const WIZARD = `${AIA} .aia-onboarding-wizard`;

function openOnboarding(): void {
  cy.visitApp();
  cy.openAutomationTab();
  cy.get(AIA).contains(".aia-onboarding-start", "QA workflow onboarding").contains("button", "Start").click();
  cy.get(`${WIZARD} [aria-current="step"]`).should("exist");
}

function next(): void {
  cy.get(WIZARD).contains("button", "Next").click();
}

/** 입력 영역의 이름표 글자 목록. 껍데기가 label(또는 넓은 묶음 div) 안 첫 span이라 순서가 곧 화면 순서다. */
function fieldLabels() {
  return cy.get(`${WIZARD} .aia-onboarding-fields > label > span, ${WIZARD} .aia-onboarding-fields > div.wide > span`);
}

function textInputs() {
  return cy.get(`${WIZARD} .aia-onboarding-fields input[type=text]`);
}

describe("AIA QA 온보딩 카드의 영어 전환 계약", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.setLanguage("en");
    openOnboarding();
  });

  // 이 스펙은 영어로 바꾼 채 끝나므로 반드시 한국어로 되돌린다.
  after(() => {
    cy.restoreLanguage();
  });

  it("1단계 이름표와 자리글이 모두 영어이고, 필수 칸에는 언어와 무관한 * 표시가 붙는다", () => {
    cy.get(`${WIZARD} [aria-current="step"]`).should("contain.text", "Target system");
    fieldLabels().should("have.length", 6);
    fieldLabels().eq(0).should("have.text", "System name *");
    fieldLabels().eq(1).should("have.text", "Workflow id *");
    fieldLabels().eq(2).should("have.text", "Business areas");
    fieldLabels().eq(3).should("have.text", "Repository *");
    fieldLabels().eq(4).should("have.text", "Target address");
    fieldLabels().eq(5).should("have.text", "Work branch (when fixing)");

    // 자리글도 영어 쪽을 고른다. 주소 예시처럼 언어와 무관한 글자는 영어 자리글에도 그대로 남는다.
    textInputs().should("have.length", 4);
    textInputs().eq(0).should("have.attr", "placeholder", "e.g. HR portal");
    textInputs().eq(1).should("have.attr", "placeholder", "lowercase, digits, hyphens — e.g. hr-portal");
    textInputs().eq(2).should("have.attr", "placeholder", "e.g. sign-in, orders, billing, notifications");
    textInputs().eq(3).should("have.attr", "placeholder")
      .and("contain", "https://dev.example.com")
      .and("contain", "mobile package name");
    cy.get(`${WIZARD} .aia-onboarding-fields`).invoke("text").should("not.match", /[가-힣]/);
  });

  it("1단계에서 넓은 칸은 뒤의 네 칸이고 앞의 이름·id 두 칸에는 wide가 붙지 않는다", () => {
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).should("have.length", 6);
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).eq(0).should("not.have.class", "wide");
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).eq(1).should("not.have.class", "wide");
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).eq(2).should("have.class", "wide");
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).eq(3).should("have.class", "wide");
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).eq(4).should("have.class", "wide");
    cy.get(`${WIZARD} .aia-onboarding-fields > label`).eq(5).should("have.class", "wide");
  });

  it("2단계 계정 역할 묶음은 영어 선택지 다섯 개 중 팩 기본값 세 개만 켠 채로 시작한다", () => {
    next();
    cy.get(`${WIZARD} [aria-current="step"]`).should("contain.text", "Test environment");
    cy.get(`${WIZARD} .aia-onboarding-choices label`).should("have.length", 5);
    cy.get(`${WIZARD} .aia-onboarding-choices label`).eq(0).should("have.text", "Regular user");
    cy.get(`${WIZARD} .aia-onboarding-choices label`).eq(4).should("have.text", "Other tenant or owner (authz check)");
    // 기본값은 일반 사용자·관리자·타 조직(인가 검증) — 인가 검증은 빼 두면 가장 먼저 놓치는 축이다.
    const expected = [true, true, false, false, true];
    cy.get(`${WIZARD} .aia-onboarding-choices input[type=checkbox]`).each(($box, index) => {
      expect($box.is(":checked"), `option ${index}`).to.eq(expected[index]);
    });
  });

  it("3단계 검증 축 묶음은 영어 선택지 여덟 개 중 네 개가 켜진 채로 시작한다", () => {
    next();
    next();
    cy.get(`${WIZARD} [aria-current="step"]`).should("contain.text", "Scenario axes and rules");
    cy.get(`${WIZARD} .aia-onboarding-choices label`).should("have.length", 8);
    cy.get(`${WIZARD} .aia-onboarding-choices label`).eq(0).should("have.text", "Input and validation");
    cy.get(`${WIZARD} .aia-onboarding-choices label`).eq(7).should("have.text", "Performance and latency");
    cy.get(`${WIZARD} .aia-onboarding-choices input[type=checkbox]:checked`).should("have.length", 4);
  });
});
