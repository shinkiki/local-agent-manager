/// <reference types="cypress" />
// 애드온 도구 탭 줄(AddonsView.tsx의 `SettingsSubTabs`)이 좁은 화면에서 겹치지 않는지 본다.
//
// 좁은 화면 규칙(App.css)의 `.chat-hub-tabs > button:not(...)`은 명시도 (0,3,1)로
// `min-width: 0; flex: 1`을 걸어 탭을 균등 분배한다. 설정 상위 탭은 같은 :not()을 단 예외
// 규칙으로 이걸 되돌려 가로 스크롤로 넘기는데, 중메뉴 바(`settings-subtab-nav`)에는 그
// 예외가 없었다. 탭이 셋일 때는 들어맞아 드러나지 않다가 도구 축으로 여섯(외부 MCP·SSH·
// 데이터베이스·Cypress·Mermaid·Claude Code)이 되자 라벨이 버튼 밖으로 넘쳐 이웃 탭 아이콘 위에
// 겹쳐 그려졌다(모바일 원격 화면에서 발견).
//
// 문구가 아니라 배치만 붙잡는다 — 라벨이 제 버튼 안에 담기는지, 이웃 버튼끼리 가로로
// 겹치지 않는지. 넓은 화면에서는 원래대로 한 줄에 모두 보인다.
const TABS = [
  "addons.tab.mcp",
  "addons.tab.ssh",
  "addons.tab.db",
  "addons.tab.k8s",
  "addons.tab.peers",
  "addons.tab.runners",
  "addons.tab.index",
  "addons.tab.cypress",
  "addons.tab.mermaid",
  "addons.tab.claude",
] as const;

const NARROW = 390;

function openAddons(width: number) {
  cy.viewport(width, 844);
  cy.visitApp();
  cy.openView("addons").should("be.visible");
  cy.anchor("addons.tab.mcp").should("have.class", "active");
}

/** 탭 버튼과 그 안 라벨(span)의 뷰포트 기준 사각형을 탭 순서대로 모은다. */
function tabRects() {
  return cy.get('.addons-view .settings-subtab-nav > button').then(($buttons) => {
    expect($buttons, "탭이 모두 그려진다").to.have.length(TABS.length);
    return Array.from($buttons).map((button) => ({
      button: button.getBoundingClientRect(),
      label: (button.querySelector("span") ?? button).getBoundingClientRect(),
    }));
  });
}

describe("좁은 화면 애드온 도구 탭 줄의 겹침", () => {
  it("390px에서 라벨이 제 버튼 안에 담기고 이웃 탭과 겹치지 않는다", () => {
    openAddons(NARROW);

    tabRects().then((rects) => {
      rects.forEach(({ button, label }, index) => {
        // 1) 라벨이 버튼 밖으로 넘치면 이웃 탭 위에 그려진다. 먼저 이 자리를 본다.
        expect(label.right, `${TABS[index]} 라벨이 버튼 오른쪽을 넘지 않는다`)
          .to.be.at.most(Math.ceil(button.right) + 1);
        expect(label.left, `${TABS[index]} 라벨이 버튼 왼쪽을 넘지 않는다`)
          .to.be.at.least(Math.floor(button.left) - 1);
      });

      // 2) 버튼끼리도 가로로 물리지 않아야 한다 — 넘친 라벨이 없어도 균등 분배로 찌그러지면
      //    아이콘과 글자가 서로의 자리를 침범한다.
      for (let index = 1; index < rects.length; index += 1) {
        expect(rects[index].button.left, `${TABS[index]}가 앞 탭과 겹치지 않는다`)
          .to.be.at.least(Math.floor(rects[index - 1].button.right) - 1);
      }
    });

    // 3) 좁은 화면에서는 줄을 나눠 담지 않고 가로로 스크롤한다 — 탭 줄 자체는 뷰포트를
    //    넘지 않고, 내용만 넘쳐 스크롤이 생긴다.
    cy.get(".addons-view .settings-subtab-nav").then(($nav) => {
      const nav = $nav[0];
      expect(nav.getBoundingClientRect().width, "탭 줄이 뷰포트를 넘지 않는다").to.be.at.most(NARROW);
      expect(nav.scrollWidth, "탭이 한 줄에 다 들어가지 않아 가로 스크롤이 생긴다")
        .to.be.greaterThan(nav.clientWidth);
    });

    // 4) 스크롤해서 마지막 탭까지 실제로 누를 수 있다.
    cy.get(".addons-view .settings-subtab-nav").scrollTo("right");
    cy.anchor("addons.tab.claude").click();
    cy.anchor("addons.tab.claude").should("have.class", "active");
    cy.anchor("addons.claude-plugins-content").should("be.visible");
  });

  it("넓은 화면에서는 모든 탭이 스크롤 없이 한 줄에 모두 보인다", () => {
    openAddons(1280);

    cy.get(".addons-view .settings-subtab-nav").then(($nav) => {
      const nav = $nav[0];
      expect(nav.scrollWidth, "넓은 화면에서는 넘치지 않는다").to.be.at.most(nav.clientWidth + 1);
    });
    TABS.forEach((anchor) => cy.anchor(anchor).should("be.visible"));
  });
});
