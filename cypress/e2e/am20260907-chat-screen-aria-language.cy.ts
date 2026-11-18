/// <reference types="cypress" />
// 영어 UI에서 채팅 화면의 '보이는 문구'와 '접근성 라벨'이 같은 언어로 맞는지 본다.
// 런타임 번역 카탈로그는 화면에 그려지는 텍스트 노드만 덮으므로, aria-label·title처럼 속성으로만
// 존재하는 문구는 컴포넌트가 text(ko, en)으로 직접 골라야 한다. QA #39 조치 뒤의 기대 동작:
// - 탭 줄 aria-label: src/components/ChatView.tsx ("채팅 보기" / "Chat views")
// - 채팅 목록 aria-label ("열린 채팅 목록" / "Open chats")
// - 목록 접기 버튼 aria-label·title ("채팅 목록 숨기기" / "Hide chat list")
// - 목록 복원 버튼 aria-label·title ("채팅 목록 보기" / "Show chat list")
// UI 언어는 백엔드에 남아 뒤따르는 스펙으로 새므로 끝에서 한국어로 되돌린다.

function tablist() {
  // 설정 중메뉴도 같은 `chat-hub-tabs` 클래스를 쓴다(SettingsSubTabs.tsx:63). 채팅 쪽만 잡는다.
  return cy.get(".chat-hub > .chat-hub-tabs [role=\"tablist\"]");
}

describe("채팅 화면의 언어 전환 — 보이는 문구와 접근성 라벨", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("영어 UI에서 탭·버튼 문구와 탭 줄·채팅 목록의 접근성 라벨이 함께 영어로 바뀐다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.openView("chat");

    // 1) 보이는 쪽 — 탭 세 개 문구가 모두 영어다.
    cy.anchor("chat.tab.conversation").should("have.text", "Conversation");
    cy.anchor("chat.tab.activity").should("have.text", "Activity");
    cy.anchor("chat.tab.schedules").should("have.text", "Recurring requests");

    // 세션이 없을 때의 시작 카드와 목록의 '새 채팅'도 번역된다.
    cy.contains(".chat-launch-card h2", "New CLI chat").should("be.visible");
    cy.get(".chat-runtime-list-new").should("contain.text", "New chat");
    cy.get(".chat-runtime-list header").should("contain.text", "Chat");

    // 2) 접근성 라벨도 같은 언어다.
    tablist().should("have.attr", "aria-label", "Chat views");
    cy.get(".chat-runtime-list").should("have.attr", "aria-label", "Open chats");
    cy.get(".chat-runtime-list .secondary-pane-toggle")
      .should("have.attr", "aria-label", "Hide chat list")
      .and("have.attr", "title", "Hide chat list");

    // 목록을 접으면 드러나는 복원 버튼도 라벨·꼬리표가 한 언어다.
    cy.get(".chat-runtime-list .secondary-pane-toggle").click();
    cy.get(".chat-runtime-list").should("not.exist");
    cy.get(".chat-hub > .chat-hub-tabs button.chat-list-restore")
      .should("have.attr", "aria-label", "Show chat list")
      .and("have.attr", "title", "Show chat list");
    cy.get(".chat-hub > .chat-hub-tabs button.chat-list-restore span").should("have.text", "Chat");

    // 3) 탭을 옮겨도, 다른 화면을 다녀와도, 새로고침해도 유지된다.
    cy.anchor("chat.tab.schedules").click().should("have.class", "active");
    tablist().should("have.attr", "aria-label", "Chat views");

    cy.openView("dashboard");
    cy.openView("chat");
    tablist().should("have.attr", "aria-label", "Chat views");

    cy.reload();
    cy.openView("chat");
    cy.anchor("chat.tab.conversation").should("have.text", "Conversation");
    tablist().should("have.attr", "aria-label", "Chat views");

    // 4) 한국어로 되돌리면 양쪽이 한국어로 맞는다.
    cy.setLanguage("ko");
    cy.openView("chat");
    cy.anchor("chat.tab.conversation").should("have.text", "대화");
    tablist().should("have.attr", "aria-label", "채팅 보기");
    // 목록은 위에서 접어 둔 채(저장됨)이므로 복원 버튼으로 다시 열고 라벨을 본다.
    cy.get(".chat-hub > .chat-hub-tabs button.chat-list-restore")
      .should("have.attr", "aria-label", "채팅 목록 보기")
      .click();
    cy.get(".chat-runtime-list").should("have.attr", "aria-label", "열린 채팅 목록");
  });
});
