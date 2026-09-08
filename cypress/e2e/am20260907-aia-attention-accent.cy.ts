/// <reference types="cypress" />
// 선택한 메인 색상이 문서 루트에 적용되는 AM-30과 달리, 실제 소비자인 상단 AIA
// 확인 대기 강조(.attention)의 테두리·배지가 그 색을 즉시 따르고 새로고침 뒤에도
// 유지되는지 본다. 8fa8a23에서 황동 고정값을 악센트 변수로 바꾼 회귀 경계다.

const ACCENT_KEY = "agent-manager.accent-color.v1";
const THEME_KEY = "agent-manager.theme-mode.v1";

const attention = {
  id: "qa-aia-attention",
  chatId: "qa-aia-chat",
  source: "codex",
  providerSessionId: null,
  cwd: "/tmp/am-e2e-aia",
  resuming: false,
  unattended: false,
  profile: "aia",
  origin: { kind: "aia" },
  kind: "completed",
  title: "확인할 AIA 답변",
  detail: null,
  approvalId: null,
  preview: null,
  createdAt: 1_700_000_000_000,
  read: false,
};

function stubEnabledAia(): void {
  cy.stubInvoke("get_system_automation_snapshot", (request) => {
    request.continue((response) => {
      response.body.settings.systemProvider = "codex";
    });
  });
  cy.stubInvoke("get_chat_attention_snapshot", {
    statusCode: 200,
    body: { items: [attention], unreadCount: 1, pendingCount: 0 },
  });
}

function openAccentSettings(): void {
  cy.openSettingsTab("display");
}

function selectAccent(label: string): void {
  cy.get('[role="radiogroup"][aria-label="메인 색상"]')
    .contains('[role="radio"]', label)
    .click();
}

function closePreviewBubble(): void {
  cy.get(".aia-attention-bubble, .aia-attention-label").should("exist").then(($indicator) => {
    if ($indicator.filter(".aia-attention-bubble").length > 0) {
      cy.get(".aia-attention-bubble").click();
    }
  });
}

describe("AIA 확인 대기 강조의 선택 악센트 즉시 반영과 복원", () => {
  beforeEach(() => {
    stubEnabledAia();
  });

  it("확인 대기 테두리와 배지가 선택한 악센트를 즉시 따르고 새로고침 뒤에도 유지된다", () => {
    cy.visitApp({ [THEME_KEY]: "dark", [ACCENT_KEY]: "blue" });
    closePreviewBubble();

    cy.anchor("topbar.aia")
      .should("have.class", "attention")
      .and("have.css", "border-color", "rgba(88, 166, 255, 0.52)");
    cy.get(".aia-attention-label")
      .should("have.css", "background-color", "rgb(88, 166, 255)")
      .and("have.css", "color", "rgb(16, 24, 31)");

    openAccentSettings();
    selectAccent("바이올렛");
    cy.anchor("topbar.aia")
      .should("have.css", "border-color", "rgba(177, 140, 255, 0.52)");
    cy.get(".aia-attention-label")
      .should("have.css", "background-color", "rgb(177, 140, 255)");
    cy.window().then((window) => {
      expect(window.localStorage.getItem(ACCENT_KEY)).to.equal("violet");
    });

    cy.reload();
    closePreviewBubble();
    cy.anchor("topbar.aia")
      .should("have.class", "attention")
      .and("have.css", "border-color", "rgba(177, 140, 255, 0.52)");
    cy.get(".aia-attention-label")
      .should("have.css", "background-color", "rgb(177, 140, 255)");
  });
});
