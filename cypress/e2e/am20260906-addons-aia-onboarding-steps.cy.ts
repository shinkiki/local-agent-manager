// AM-97 · 워크플로 → 자동화 → 'QA 워크플로 온보딩' 카드의 단계 이동 경계와 단계 간 입력값 잔존.
// 이 카드는 목업이던 시절 "단계 이동은 되지만 입력은 저장되지 않고 생성 버튼은 잠겨 있다"를
// 스스로 선언했다. 지금은 팩(W6)이 그리는 선언형 카드라(c9de7c43) 계약이 둘로 바뀌었다.
//   - 값은 카드가 칸 이름(key)으로 쥐는 상태라, 단계를 오가도 적은 값이 남는다.
//   - 만들기는 막혀 있는 목업 버튼이 아니라, 필수 입력이 비어 있는 동안에만 잠기는 실제 버튼이다.
// 이 스펙은 두 경계를 새 계약으로 붙잡는다: 이동의 양끝(첫 단계의 '이전', 마지막 단계에 '다음'이
// 없음), 표시기를 직접 눌러 역행할 때의 done/active 표시, 그리고 값이 **다른 단계의 다른 칸으로
// 옮겨 붙지 않는지**와 **제 칸에는 남는지**다. 잔존의 층은 셋이다: 단계를 오가도 값은 남고,
// 형제 탭을 다녀오면 패널이 DOM에 남으므로 단계도 남으며, 새로고침하면 카드가 접힌 채로 돌아와
// 다시 시작하면 첫 단계에서 연다.
//
// 자동화 탭에는 온보딩 카드가 여럿 서고(프로젝트 진행·QA) 위에 회차 목표·AIA 선제 제안 카드가
// 얹혀 온보딩 구역이 스크롤 상자 아래로 밀린다. 단언은 모두 QA 카드의 펼친 화면 안으로 좁힌다.

const STEP_LAST = "회차 운영·생성";
// 모듈로 두어 다른 스펙의 같은 이름 상수(AIA 등)와 전역에서 부딪히지 않게 한다.
export {};

const AIA = '[data-ui-anchor="workflows.automation-content"]';
const WIZARD = `${AIA} .aia-onboarding-wizard`;
const QA_CARD = "QA 워크플로 온보딩";

function openAia(): void {
  cy.visitApp();
  cy.openAutomationTab();
  startOnboarding();
}

/** 단계 화면은 카드의 시작 버튼을 눌러야 열린다. 열기 전에는 제목·설명·시작 버튼만 있다. */
function startOnboarding(): void {
  cy.get(`${AIA} [aria-current="step"]`).should("not.exist");
  cy.get(AIA).contains(".aia-onboarding-start", QA_CARD).contains("button", "시작").click();
  cy.get(WIZARD).should("have.length", 1).and("contain.text", QA_CARD);
  cy.get(`${WIZARD} [aria-current="step"]`).should("exist");
}

function currentStep() {
  return cy.get(`${WIZARD} [aria-current="step"]`);
}

/** 펼친 카드 안의 버튼. `within`을 쓰지 않아 어느 단언 뒤에도 같은 식으로 잡힌다. */
function aiaButton(label: string) {
  return cy.get(WIZARD).contains("button", label);
}

function field(label: string) {
  return cy.get(WIZARD).contains("label", label);
}

describe("애드온 자동화 QA 온보딩 카드의 단계 경계와 값 잔존", () => {
  beforeEach(() => {
    openAia();
  });

  it("첫 단계에서는 '이전'이 잠기고 마지막 단계에서는 '다음' 대신 필수 입력을 기다리는 만들기만 남는다", () => {
    // 1) 아래끝: 처음 열면 1단계이므로 뒤로 갈 곳이 없다. 잠기지 않으면 눌러도 아무 일이
    //    없는 버튼이 되어 화면이 반응하지 않는 것처럼 보인다.
    currentStep().should("contain.text", "대상 시스템");
    aiaButton("이전").should("be.disabled");

    // 2) 한 걸음 나가면 '이전'이 열리고, 되돌아오면 다시 잠긴다 — 경계가 한쪽으로만
    //    작동하고 끝나 버리지 않는지 본다.
    aiaButton("다음").click();
    currentStep().should("contain.text", "테스트 환경");
    aiaButton("이전").should("be.enabled").click();
    currentStep().should("contain.text", "대상 시스템");
    aiaButton("이전").should("be.disabled");

    // 3) 위끝: 마지막 단계에는 '다음'이 아예 없고, 그 자리에 '만들기'가 온다. 필수 입력을
    //    비워 둔 채로는 잠기며, 왜 못 누르는지를 버튼 제목과 각주가 함께 적는다.
    aiaButton(STEP_LAST).click();
    currentStep().should("contain.text", STEP_LAST);
    aiaButton("다음").should("not.exist");
    aiaButton("만들기").should("be.disabled")
      .and("have.attr", "title")
      .and("match", /^채우지 않은 필수 입력: .*시스템 이름/);
    cy.get(`${WIZARD} .aia-onboarding-missing`).should("contain.text", "시스템 이름");
    aiaButton("이전").should("be.enabled");
  });

  it("단계 표시기를 직접 눌러 건너뛰고 되돌아가도 지나온 단계만 done으로 남는다", () => {
    // 표시기는 '다음'을 거치지 않고 임의의 단계로 건너뛴다. 건너뛴 뒤에도 앞뒤 표시가
    // 현재 위치와 어긋나면 어디까지 왔는지 읽을 수 없다.
    aiaButton("기록 대상").click();
    currentStep().should("contain.text", "기록 대상");
    aiaButton("대상 시스템").should("have.class", "done");
    aiaButton("시나리오 축·규율").should("have.class", "done");
    aiaButton(STEP_LAST).should("not.have.class", "done").and("not.have.class", "active");

    // 역행하면 지나온 표시도 함께 걷힌다 — done은 '방문한 적 있음'이 아니라 '현재보다 앞'이다.
    aiaButton("테스트 환경").click();
    currentStep().should("contain.text", "테스트 환경");
    aiaButton("대상 시스템").should("have.class", "done");
    aiaButton("시나리오 축·규율").should("not.have.class", "done");
  });

  it("시나리오 단계에서 채운 값이 기록 대상 단계의 칸으로 실려 나오지 않고, 제 칸에는 남는다", () => {
    // 지키기 어려운 쪽은 **다른 단계의 다른 칸으로 옮겨 붙지 않는다**이다. 단계마다 같은 자리에
    // 다른 칸이 서므로, 값이 자리(순서)에 매이면 사용자가 치지 않은 값이 남의 칸에 들어앉는다.
    // 값은 칸 이름에 매이므로 기록 대상 단계의 칸은 제 기본값만 보여야 한다.
    aiaButton("시나리오 축·규율").click();
    field("시나리오 ID 접두어").find("input").type("AM-").should("have.value", "AM-");

    aiaButton("기록 대상").click();
    currentStep().should("contain.text", "기록 대상");
    // 기록 대상은 고르기 전까지 비어 있고, 마크다운을 골라야 그 갈래의 경로 칸이 선다.
    field("기록 대상").find("select").should("have.value", "").select("markdown");
    field("회차 문서 경로").find("input").should("have.value", "qa/rounds/{round}.md");
    field("QA 티켓 경로").find("input").should("have.value", "qa/tickets/{id}.md");
    cy.get(`${WIZARD} .aia-onboarding-fields`).find("input, textarea").each(($input) => {
      expect($input.val()).not.to.equal("AM-");
    });

    // 되돌아가면 적은 값은 제 칸에 그대로 있다 — 목업 시절과 달리 값은 카드가 쥔다.
    aiaButton("시나리오 축·규율").click();
    field("시나리오 ID 접두어").find("input").should("have.value", "AM-");
    aiaButton("기록 대상").click();
    field("기록 대상").find("select").should("have.value", "markdown");
  });

  it("대상 시스템 단계에서 친 값이 다음 단계의 같은 자리 칸에 실려 나오지 않는다 (qa28)", () => {
    // 1단계와 2단계는 같은 입력 컴포넌트가 칸 목록만 바꿔 그린다. React가 같은 자리의 입력을
    // 재사용하면 1단계 '시스템 이름'에 친 값이 2단계 같은 자리 칸에 남는다. 칸마다 key를 달아
    // 두었으므로 다음 단계의 글자 칸은 모두 비어 있어야 한다.
    field("시스템 이름").find("input").type("인사 포털").should("have.value", "인사 포털");
    field("업무 영역").find("input").type("결재 · 인쇄").should("have.value", "결재 · 인쇄");

    aiaButton("다음").click();
    currentStep().should("contain.text", "테스트 환경");
    cy.get(`${WIZARD} .aia-onboarding-fields input[type="text"]`).should("have.length.greaterThan", 0).each(($input) => {
      expect($input.val()).to.equal("");
    });
    cy.get(`${WIZARD} .aia-onboarding-fields`).should("not.contain.text", "인사 포털").and("not.contain.text", "결재 · 인쇄");

    // 되돌아가면 값은 제 칸에 되살아난다 — 값은 칸 이름으로 카드에 남는다.
    aiaButton("이전").click();
    currentStep().should("contain.text", "대상 시스템");
    field("시스템 이름").find("input").should("have.value", "인사 포털");
    field("업무 영역").find("input").should("have.value", "결재 · 인쇄");
  });

  it("형제 탭을 다녀오면 단계가 남고, 새로고침하면 접힌 카드로 돌아와 첫 단계부터 연다", () => {
    aiaButton("기록 대상").click();
    currentStep().should("contain.text", "기록 대상");

    // 같은 화면 안의 형제 탭은 패널을 DOM에 남기므로, 잠깐 확인하고 돌아온 사용자는
    // 보던 단계에서 이어 간다.
    cy.anchor("workflows.tab.catalog").click();
    cy.anchor("workflows.tab.automation").click();
    currentStep().should("contain.text", "기록 대상");

    // 새로고침은 다르다 — 워크플로 탭은 첫 탭(관리)에서 다시 시작하고, 자동화 탭을 다시 열어도
    // 펼친 카드와 단계는 남지 않아 카드가 접힌 채로 서며, 다시 시작하면 1단계다.
    cy.reload();
    cy.openAutomationTab();
    cy.get(WIZARD).should("not.exist");
    startOnboarding();
    currentStep().should("contain.text", "대상 시스템");
    aiaButton("이전").should("be.disabled");
  });
});
