/**
 * 설정 → CLI 연결·계정 탭에서 시스템 에이전트를 고른 뒤 나타나는 '실행설정' 블록의
 * 초안(draft) 계약. am20260906-system-agent-empty-readonly는 "고르지 않은 상태"에서 이
 * 블록이 없는 것만 봤고, 고른 뒤 값을 바꿔 변경 취소로 되돌리고 저장 후 새로고침까지
 * 남는지는 본 스펙이 없다. 축은 설정, 조건은 되돌리기 + 저장 후 복원.
 *
 * 하네스는 HOME만 격리하고 PATH는 호스트를 쓰므로 어떤 공급자가 연결로 잡힐지는 기기마다
 * 다르다. 그래서 공급자를 지정하지 않고 "연결됨으로 열린 첫 항목"을 골라 쓴다. 저장이 남는
 * 화면이라 재시도(retries=1)에서도 같은 결론이 나오도록 저장본을 가정하지 않고 지금 눌린
 * 값을 읽어 그 반대값으로 바꾼다.
 */
function runtime() {
  return cy.get('[data-ui-anchor="settings.system-agent-runtime"]');
}

function decision(label: string) {
  return runtime().find('[role="group"][aria-label="판단 처리"]').contains("button", label);
}

/**
 * AIA 채팅 팝업(기본 열림)이 본문 오른쪽을 덮어 실행설정 버튼 중앙을 가린다. 제안 카드를
 * 숨겨도 팝업 본체가 남으므로, 눌리는지가 아니라 잠금 상태와 저장 결과를 보려는 이 스펙은
 * 스크롤을 맞춘 뒤 force로 누른다. 가림 자체는 별도 QA 티켓으로 남긴다.
 */
function actions() {
  return runtime().find(".system-agent-runtime-actions");
}

function discardButton() {
  actions().scrollIntoView();
  return runtime().contains("button", "변경 취소");
}

function saveButton() {
  actions().scrollIntoView();
  return runtime().contains("button", "실행설정 저장");
}

const DECISIONS = ["사용자에게 확인", "추천안 자동 선택"] as const;

function readDecision() {
  return runtime().find('[role="group"][aria-label="판단 처리"] button[aria-pressed="true"]').invoke("text")
    .then((label) => {
      const current = DECISIONS.find((option) => label.startsWith(option));
      expect(current, "눌려 있는 판단 처리").to.be.ok;
      return { current: current as string, other: DECISIONS.find((option) => option !== current) as string };
    });
}

describe("시스템 에이전트 실행설정의 변경 취소와 저장 후 복원", () => {
  // 격리 백엔드는 스펙 사이에 살아 있으므로, 여기서 고른 시스템 에이전트를 그대로 두면 뒤따르는
  // 모든 스펙이 AIA 팝업(우측 고정)과 실제 CLI 오류 카드 위에서 돌게 된다. 끝에서 '선택 안 함'으로 되돌린다.
  after(() => {
    cy.visitApp();
    cy.openSettingsTab("connections");
    cy.anchor("settings.system-agent").find('[role="radio"]').first().click();
    cy.anchor("settings.system-agent").find('[role="radio"]').first().should("have.attr", "aria-checked", "true");
  });

  it("실행설정이 열리고, 판단 처리 변경은 취소로 되돌아가며 저장하면 새로고침 뒤에도 남는다", () => {
    cy.visitApp();
    cy.openView("settings");
    cy.openSettingsTab("connections");

    // 연결됨으로 열린 공급자가 하나도 없으면 이 시나리오는 이 기기에서 검증할 수 없다.
    cy.anchor("settings.system-agent").scrollIntoView();
    cy.anchor("settings.system-agent").find('[role="radio"]:not([disabled])').not(":first")
      .should("have.length.at.least", 1)
      .first()
      .click();

    // 고른 직후에는 설정 스냅샷이 아직 도착하지 않아 초안이 다시 세워진다. 초안 계약을 보려는
    // 스펙이므로 스냅샷이 도착할 틈을 준다.
    cy.wait(3000);

    // 공급자를 고르면 그 공급자 이름을 밝힌 실행설정 블록이 열린다.
    runtime().scrollIntoView();
    runtime().should("be.visible");
    runtime().find(".system-agent-runtime-head strong").invoke("text").should("contain", "실행설정");

    // 방금 골랐을 뿐 초안은 저장본과 같으므로 두 버튼은 잠겨 있다.
    discardButton().should("be.disabled");
    saveButton().should("be.disabled");

    readDecision().then(({ current, other }) => {
      // 저장본과 다른 값을 누르면 초안이 더러워져 두 버튼이 열린다.
      decision(current).should("have.attr", "aria-pressed", "true");
      decision(other).click();
      decision(other).should("have.attr", "aria-pressed", "true");
      runtime().find(".approval-mode-warning, .approval-mode-hint").should("exist");
      discardButton().should("not.be.disabled");
      saveButton().should("not.be.disabled");

      // 변경 취소는 저장하지 않은 초안을 저장본으로 되돌리고 버튼을 다시 잠근다.
      discardButton().click({ force: true });
      decision(current).should("have.attr", "aria-pressed", "true");
      discardButton().should("be.disabled");
      saveButton().should("be.disabled");

      // 이번에는 저장한다. 저장이 끝나면 초안과 저장본이 같아져 버튼이 다시 잠긴다.
      decision(other).click();
      saveButton().click({ force: true });
      saveButton().should("be.disabled");
      discardButton().should("be.disabled");

      // 새로고침 뒤에도 고른 공급자와 저장한 판단 처리가 그대로 남는다.
      cy.reload();
      cy.openView("settings");
      cy.openSettingsTab("connections");
      runtime().scrollIntoView();
      runtime().should("be.visible");
      decision(other).should("have.attr", "aria-pressed", "true");
      saveButton().should("be.disabled");
    });
  });
});
