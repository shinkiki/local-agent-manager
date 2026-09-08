// 채팅 허브 탭 줄(`chat-hub-tabs`)이 보조기술에 무엇을 내놓는지 붙잡는다.
// QA #24 조치 뒤의 기대 동작: 탭 줄은 `.chat-hub-tabs` 안쪽의 `.chat-hub-tablist[role=tablist]`가
// 탭 세 개만 소유하고(role="tab"·aria-selected), 목록 복원·새 채팅처럼 탭이 아닌 버튼은 같은
// 줄(.chat-hub-tabs)에 남되 tablist 바깥에 놓인다. 예전에는 .chat-hub-tabs 자체가 tablist를
// 선언하면서 안에 role="tab"이 하나도 없어 '탭 0개짜리 탭 목록'으로 읽혔고, 비탭 버튼까지 섞였다.
// 같은 앱의 설정 중메뉴(`SettingsSubTabs.tsx`)와 대조해 규약이 맞는지도 본다.

const CHAT_TABS = ["chat.tab.conversation", "chat.tab.activity", "chat.tab.schedules"] as const;

// 설정 중메뉴도 겉모습을 맞추려 같은 `chat-hub-tabs` 클래스를 쓴다(SettingsSubTabs.tsx:63).
// 화면은 감춰질 뿐 그대로 남으므로 클래스만으로 잡으면 애드온을 다녀온 뒤 두 탭 줄이 함께 잡힌다.
function tabBar() {
  return cy.get(".chat-hub > .chat-hub-tabs");
}

function tablist() {
  return tabBar().find('[role="tablist"]');
}

describe("채팅 허브 탭 줄의 보조기술 계약", () => {
  it("tablist는 탭 세 개만 소유하고 선택 상태를 aria-selected로 전달하며, 비탭 버튼은 바깥에 둔다", () => {
    cy.visitApp();
    cy.openView("chat");

    // 바깥 줄은 레이아웃 껍데기일 뿐 tablist를 선언하지 않는다.
    tabBar().should("not.have.attr", "role");
    tablist().should("have.length", 1).and("have.attr", "aria-label", "채팅 보기");

    // tablist 안에는 정확히 탭 세 개가 있고, 모두 role="tab"·aria-selected를 갖는다.
    tablist().find('[role="tab"]').should("have.length", CHAT_TABS.length);
    tablist().children().should("have.length", CHAT_TABS.length);
    CHAT_TABS.forEach((anchor) => {
      cy.anchor(anchor).should("have.attr", "role", "tab").and("have.attr", "aria-selected");
    });
    cy.anchor("chat.tab.conversation").should("have.class", "active").and("have.attr", "aria-selected", "true");
    cy.anchor("chat.tab.activity").should("have.attr", "aria-selected", "false");
    cy.anchor("chat.tab.schedules").should("have.attr", "aria-selected", "false");

    // 클릭 전환이 aria-selected에도 반영된다.
    cy.anchor("chat.tab.schedules").click().should("have.class", "active").and("have.attr", "aria-selected", "true");
    cy.anchor("chat.tab.conversation").should("have.attr", "aria-selected", "false");
    tablist().find('[aria-selected="true"]').should("have.length", 1);

    // 목록을 접으면 '채팅 목록 보기' 버튼이 같은 줄에 나오지만 tablist 바깥이고 tab 역할이 없다.
    cy.anchor("chat.tab.conversation").click();
    cy.get('.chat-runtime-list button[aria-label="채팅 목록 숨기기"]').click();
    tabBar().find("button.chat-list-restore").should("have.length", 1).and("not.have.attr", "role");
    tablist().find("button.chat-list-restore").should("have.length", 0);
    tablist().find("button").should("have.length", CHAT_TABS.length);

    // 대조: 같은 앱의 설정 중메뉴는 같은 자리에서 규약을 모두 지킨다.
    cy.openView("addons");
    cy.anchor("addons.tab.aia")
      .should("have.attr", "role", "tab")
      .and("have.attr", "aria-selected", "true")
      .and("have.attr", "tabindex", "0");
    cy.get('[role="tabpanel"]:visible').should("have.length.greaterThan", 0);

    // 채팅으로 돌아와도 탭 줄 계약은 그대로다.
    cy.openView("chat");
    tablist().find('[role="tab"]').should("have.length", CHAT_TABS.length);
  });
});
