// AM-97 · 애드온 → 아이아 → QA 워크플로 온보딩(목업)의 단계 이동 경계와 단계 간 입력값 잔존.
// 애드온 → 아이아 탭의 'QA 워크플로 온보딩' 목업이 스스로 선언한 계약을 붙잡는다.
// 그 선언은 두 줄이다 — "단계 이동은 되지만 입력은 저장되지 않고 생성 버튼은 잠겨 있다"
// (src/components/AddonsView.tsx:113, :183). 화면에도 같은 문구가 각주로 붙어 있으므로
// 사용자는 그 문구를 읽고 값이 사라지는 것을 놀라지 않는다. 반대로 단계 이동까지 막히거나
// 생성 버튼이 열려 버리면 목업이 아직 아무것도 만들지 못하는데 만들어진 것처럼 보인다.
//
// 기존 addons.cy.ts는 시작 버튼을 눌러 "다음"을 한 번 누르고 마지막 단계의 생성 버튼이 잠긴 것까지만 본다.
// 여기서 새로 보는 것은 이동의 양끝 경계(첫 단계의 '이전', 마지막 단계에 '다음'이 없음),
// 단계 표시기를 직접 눌러 역행할 때의 done/active 표시, 그리고 값·단계의 잔존 규칙이다.
// 잔존은 층이 셋으로 갈린다: 단계를 떠나면 입력은 사라지고(AiaQaStepFields 재마운트),
// 형제 탭을 다녀오면 패널이 DOM에 남으므로 단계는 유지되며(SettingsSubTabs.tsx:88의
// hidden 처리), 새로고침하면 stepIndex가 초기값 0으로 떨어진다.

const STEP_LAST = "회차 운영·생성";

function openAia(): void {
  cy.visitApp();
  cy.openView("addons").should("be.visible");
  cy.openAddonsTab("aia");
  startOnboarding();
}

/** 단계 화면은 시작 버튼을 눌러야 열린다. 열기 전에는 소개와 시작 버튼만 있다. */
function startOnboarding(): void {
  cy.get(AIA).find('[aria-current="step"]').should("not.exist");
  aiaButton("온보딩 시작").click();
  cy.get(AIA).find('[aria-current="step"]').should("exist");
}

const AIA = '[data-ui-anchor="addons.aia-content"]';

function currentStep() {
  return cy.get(`${AIA} [aria-current="step"]`);
}

/** 아이아 패널 안의 버튼. `within`을 쓰지 않아 어느 단언 뒤에도 같은 식으로 잡힌다. */
function aiaButton(label: string) {
  return cy.get(AIA).contains("button", label);
}

describe("애드온 아이아 온보딩 목업의 단계 경계와 값 잔존", () => {
  beforeEach(() => {
    openAia();
  });

  it("첫 단계에서는 '이전'이 잠기고 마지막 단계에서는 '다음' 대신 잠긴 생성 버튼만 남는다", () => {
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

    // 3) 위끝: 마지막 단계에는 '다음'이 아예 없고, 그 자리에 잠긴 '워크플로 생성'이 온다.
    //    생성이 열려 있으면 아무것도 만들지 못하는 목업이 만들어 주는 화면으로 읽힌다.
    aiaButton(STEP_LAST).click();
    currentStep().should("contain.text", STEP_LAST);
    aiaButton("다음").should("not.exist");
    aiaButton("워크플로 생성").should("be.disabled").and("have.attr", "title", "준비 중");
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

  it("시나리오 단계에서 채운 값이 기록 대상 단계의 칸으로 실려 나오지 않는다", () => {
    // 목업의 각주는 값이 저장되지 않는다고 알린다. 지키기 어려운 쪽은 "사라진다"가 아니라
    // **다른 단계의 다른 칸으로 옮겨 붙지 않는다**이다. 단계 필드는 stepId에 따라 다른
    // <label><input>을 돌려주므로, 같은 자리에 오는 입력을 React가 재사용하면 사용자가
    // 치지 않은 값이 남의 칸에 들어앉는다. 기록 대상 단계는 별도 컴포넌트로 갈라 두어
    // 그 재사용이 끊긴다(src/components/AddonsView.tsx의 AiaQaRecordFields).
    cy.get(AIA).contains("목업 화면입니다. 입력값은 저장되지 않고").scrollIntoView().should("be.visible");

    aiaButton("시나리오 축·규율").click();
    cy.get(AIA).contains("label", "시나리오 ID 접두어").find("input").type("AM-").should("have.value", "AM-");

    aiaButton("기록 대상").click();
    currentStep().should("contain.text", "기록 대상");
    cy.get(AIA).contains("label", "기록 대상").find("select").should("have.value", "markdown");
    cy.get(AIA).contains("label", "회차 문서 경로").find("input").should("have.value", "qa/rounds/{round}.md");
    cy.get(AIA).contains("label", "QA 티켓 경로").find("input").should("have.value", "qa/tickets/{id}.md");
    cy.get(AIA).should("not.contain.text", "AM-");
  });

  it("대상 시스템 단계에서 친 값이 다음 단계의 같은 자리 칸에 실려 나오지 않는다 (qa28)", () => {
    // 위 케이스는 별도 컴포넌트로 갈린 기록 대상 단계만 봤다. 같은 컴포넌트(AiaQaStepFields)가
    // stepId에 따라 다른 <input>을 돌려주는 두 단계 사이에서는, 단계별 key가 없으면 React가
    // 같은 자리의 비제어 입력을 재사용해 1단계 '시스템 이름'에 친 값이 2단계 '계정 파일 키'에
    // 남는다. 단계마다 key를 달아 재마운트하므로 다음 단계의 글자 칸은 모두 비어 있어야 한다.
    // 재사용은 형제 자리가 같고 컴포넌트 종류가 같을 때만 일어난다: 1단계 둘째 칸 '업무 영역'과
    // 2단계 둘째 칸 '계정 파일 키'가 둘 다 MockTextField라 그 자리가 실제 재현 지점이다.
    cy.get(AIA).contains("label", "시스템 이름").find("input").type("인사 포털").should("have.value", "인사 포털");
    cy.get(AIA).contains("label", "업무 영역").find("input").type("결재 · 인쇄").should("have.value", "결재 · 인쇄");

    aiaButton("다음").click();
    currentStep().should("contain.text", "테스트 환경");
    cy.get(AIA).contains("label", "계정 파일 키").find("input").should("have.value", "");
    cy.get(AIA).find(".aia-onboarding-fields input[type=\"text\"]").each(($input) => {
      expect($input.val()).to.equal("");
    });
    cy.get(AIA).should("not.contain.text", "인사 포털").and("not.contain.text", "결재 · 인쇄");

    // 되돌아가도 값은 되살아나지 않는다 — 목업 각주("입력값은 저장되지 않고")와 같은 말이다.
    aiaButton("이전").click();
    currentStep().should("contain.text", "대상 시스템");
    cy.get(AIA).contains("label", "시스템 이름").find("input").should("have.value", "");
  });

  it("형제 탭을 다녀오면 단계가 남고, 새로고침하면 첫 단계로 돌아온다", () => {
    cy.anchor("addons.aia-content").contains("button", "기록 대상").click();
    currentStep().should("contain.text", "기록 대상");

    // 같은 화면 안의 형제 탭은 패널을 DOM에 남기므로, 잠깐 확인하고 돌아온 사용자는
    // 보던 단계에서 이어 간다.
    cy.openAddonsTab("codex");
    cy.openAddonsTab("aia");
    currentStep().should("contain.text", "기록 대상");

    // 새로고침은 다르다 — 애드온 탭 자체는 localStorage로 남지만(AddonsView.tsx:42)
    // 온보딩 단계는 남기지 않으므로 1단계로 떨어진다.
    cy.reload();
    cy.openView("addons").should("be.visible");
    cy.anchor("addons.tab.aia").should("have.class", "active");
    startOnboarding();
    currentStep().should("contain.text", "대상 시스템");
    cy.anchor("addons.aia-content").contains("button", "이전").should("be.disabled");
  });
});
