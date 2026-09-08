/**
 * 채팅 화면의 채팅 목록 패널 접기/펼치기와, 탭 줄이 그 상태에 따라 무엇을 내보내는지.
 *
 * AM-77이 `chat.tab.*` 세 탭의 딥링크·잔존·접근성을 다뤘지만, 그 탭 줄이 조건부로
 * 함께 그리는 두 버튼 — 채팅 목록 복원(ChatView.tsx:1572)과 새 채팅 단축
 * (ChatView.tsx:1578) — 과 접힘 상태의 저장(agent-manager.chat-list-pane,
 * src/lib/secondaryPane.ts:19)은 어느 스펙도 잡은 적이 없다. 여기서는 그쪽을 붙잡는다.
 * 격리 백엔드에는 열린 채팅이 0건이므로 대화 내용이 아니라 빈 상태의 목록 계약과
 * 탭·접힘의 조합을 본다. 마지막 하나는 AM-77이 본 탭 잔존 계약의 회귀 고정이다.
 */
const LIST_KEY = "agent-manager.chat-list-pane";

const activeTab = (name: string) => cy.anchor(`chat.tab.${name}`).should("have.class", "active");
const inactiveTab = (name: string) => cy.anchor(`chat.tab.${name}`).should("not.have.class", "active");

describe("채팅 목록 접기와 탭 줄의 조건부 버튼", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("chat");
  });

  it("처음에는 대화 탭만 활성이고, 탭을 바꾸면 언제나 하나만 활성으로 남는다", () => {
    activeTab("conversation");
    inactiveTab("activity");
    inactiveTab("schedules");

    cy.anchor("chat.tab.activity").click();
    activeTab("activity");
    inactiveTab("conversation");
    inactiveTab("schedules");

    cy.anchor("chat.tab.schedules").click();
    activeTab("schedules");
    inactiveTab("activity");

    cy.anchor("chat.tab.conversation").click();
    activeTab("conversation");
    inactiveTab("schedules");
  });

  it("채팅이 하나도 없으면 목록에 '새 채팅'만 켜져 있고 탭 줄에는 새 채팅 단축 버튼이 나오지 않는다", () => {
    cy.get(".chat-runtime-list").should("be.visible");
    cy.get(".chat-runtime-list header span").should("have.text", "0");
    cy.get(".chat-runtime-list-new").should("have.class", "active").and("have.attr", "aria-current", "page");
    // 열린 채팅이 없으면 단축 버튼은 목록을 접어도 나오지 않는다.
    cy.get(".chat-new-chat-shortcut").should("not.exist");
  });

  it("목록을 접으면 탭 줄에 복원 버튼이 나오고 접힘 상태는 새로고침을 건너 남는다", () => {
    cy.get(".chat-list-restore").should("not.exist");
    cy.get(".chat-runtime-list header .secondary-pane-toggle").click();
    cy.get(".chat-runtime-list").should("not.exist");
    cy.get(".chat-list-restore").should("be.visible").and("have.attr", "aria-expanded", "false");
    cy.window().then((win) => expect(win.localStorage.getItem(LIST_KEY)).to.equal("closed"));

    cy.reload();
    cy.openView("chat");
    cy.get(".chat-runtime-list").should("not.exist");
    cy.get(".chat-list-restore").should("be.visible");

    cy.get(".chat-list-restore").click();
    cy.get(".chat-runtime-list").should("be.visible");
    cy.get(".chat-list-restore").should("not.exist");
    cy.window().then((win) => expect(win.localStorage.getItem(LIST_KEY)).to.equal("open"));
  });

  it("목록이 접혀 있어도 반복 요청 탭에서는 복원 버튼을 감추고, 대화 탭으로 돌아오면 되살린다", () => {
    cy.get(".chat-runtime-list header .secondary-pane-toggle").click();
    cy.get(".chat-list-restore").should("be.visible");

    cy.anchor("chat.tab.schedules").click();
    cy.get(".chat-list-restore").should("not.exist");
    // 탭을 옮겼다고 접힘 상태를 되돌리지는 않는다.
    cy.window().then((win) => expect(win.localStorage.getItem(LIST_KEY)).to.equal("closed"));

    cy.anchor("chat.tab.activity").click();
    cy.get(".chat-list-restore").should("be.visible");
  });

  it("고른 탭은 다른 화면을 다녀와도 남지만 새로고침하면 대화 탭으로 돌아간다", () => {
    cy.anchor("chat.tab.activity").click();
    activeTab("activity");

    cy.openView("sessions");
    cy.openView("chat");
    activeTab("activity");
    inactiveTab("conversation");

    cy.reload();
    cy.openView("chat");
    activeTab("conversation");
    inactiveTab("activity");
  });
});
