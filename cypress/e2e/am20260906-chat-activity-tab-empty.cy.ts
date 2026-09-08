// 채팅이 하나도 없는 상태에서 '작업 로그' 탭이 '대화' 탭과 다른 빈 상태를 내는지, 그리고
// 채팅 목록을 접었을 때 탭 줄에 드러나는 복원 버튼이 탭마다 다르게 붙는지 본다.
// - 빈 상태 갈래: src/components/ChatView.tsx:1636 (activity면 EmptyState, 아니면 새 CLI 채팅 카드)
// - 복원 버튼 조건: src/components/ChatView.tsx:1572 (tab !== "schedules" && !chatListOpen)
// - '새 채팅' 단축 조건: src/components/ChatView.tsx:1578 (여기에 session까지 붙어 세션 없이는 안 나온다)
// 탭은 컴포넌트 상태(ChatView.tsx:249)라 화면 전환에는 남고 새로고침에는 대화로 돌아가며, 목록 접힘은
// 보조 패널 키로 저장되므로(ChatView.tsx:250,265) 화면 전환·새로고침을 넘어 남아야 한다.
// 기존 AM 시나리오는 반복 요청 탭과 딥링크 탭 전환만 봤고 작업 로그 탭 자체는 다룬 적이 없다.

function tabs() {
  return cy.get(".chat-hub-tabs");
}

function restoreButton() {
  return cy.get('.chat-hub-tabs button[aria-label="채팅 목록 보기"]');
}

describe("세션 없는 채팅 화면의 작업 로그 탭 빈 상태와 목록 접힘 계약", () => {
  it("작업 로그 탭은 다른 빈 상태를 내고, 접힌 목록의 복원 버튼은 반복 요청 탭에서만 사라진다", () => {
    cy.visitApp();
    cy.openView("chat");

    // 기본은 대화 탭이고, 세션이 없으므로 '새 CLI 채팅' 시작 카드가 자리를 차지한다.
    cy.anchor("chat.tab.conversation").should("have.class", "active");
    cy.contains(".chat-launch-card h2", "새 CLI 채팅").should("be.visible");
    cy.get(".chat-runtime-empty").should("not.exist");

    // 작업 로그로 옮기면 시작 카드가 아니라 전용 빈 상태가 나온다 — 두 탭의 빈 상태가 다르다.
    cy.anchor("chat.tab.activity").click().should("have.class", "active");
    cy.anchor("chat.tab.conversation").should("not.have.class", "active");
    cy.get(".chat-runtime-empty").should("contain.text", "표시할 작업 로그가 없습니다");
    cy.contains(".chat-launch-card h2", "새 CLI 채팅").should("not.exist");

    // 목록이 펼쳐져 있는 동안에는 탭 줄에 복원 버튼이 없다.
    cy.get(".chat-runtime-list").should("be.visible");
    restoreButton().should("not.exist");

    // 목록을 접으면 탭 줄에 복원 버튼이 드러난다. 세션이 없으므로 '새 채팅' 단축은 따라 나오지 않는다.
    cy.get('.chat-runtime-list button[aria-label="채팅 목록 숨기기"]').click();
    cy.get(".chat-runtime-list").should("not.exist");
    restoreButton().should("have.attr", "aria-expanded", "false");
    tabs().find(".chat-new-chat-shortcut").should("not.exist");

    // 반복 요청 탭에는 채팅 목록 자체가 없으므로 복원 버튼도 붙지 않는다.
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    restoreButton().should("not.exist");

    // 작업 로그로 돌아오면 접힌 상태 그대로 복원 버튼이 다시 붙는다.
    cy.anchor("chat.tab.activity").click().should("have.class", "active");
    cy.get(".chat-runtime-empty").should("contain.text", "표시할 작업 로그가 없습니다");
    restoreButton().should("exist");

    // 화면을 다녀와도 채팅 화면은 감춰질 뿐 다시 그려지지 않으므로 고른 탭이 그대로 남는다.
    cy.openView("dashboard");
    cy.openView("chat");
    cy.anchor("chat.tab.activity").should("have.class", "active");
    cy.get(".chat-runtime-empty").should("contain.text", "표시할 작업 로그가 없습니다");
    cy.get(".chat-runtime-list").should("not.exist");
    restoreButton().should("exist");

    // 새로고침은 컴포넌트 상태를 버리므로 탭은 대화로 돌아가지만, 저장되는 목록 접힘은 남는다.
    cy.reload();
    cy.openView("chat");
    cy.anchor("chat.tab.conversation").should("have.class", "active");
    cy.get(".chat-runtime-list").should("not.exist");

    // 복원 버튼을 누르면 목록이 되돌아오고 버튼은 다시 사라진다.
    restoreButton().click();
    cy.get(".chat-runtime-list").should("be.visible");
    restoreButton().should("not.exist");
  });
});
