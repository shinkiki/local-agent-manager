/// <reference types="cypress" />
// 애드온 도구 탭 줄(AddonsView.tsx의 `SettingsSubTabs`)에서 탭 버튼의 접근성 이름이
// 탭 라벨 하나로만 읽히는지 본다.
//
// 탭 버튼은 `<item.icon size={13} aria-hidden="true" /><span>{라벨}</span>` 한 벌로 선다
// (SettingsSubTabs.tsx:78). 브랜드 표식은 `alt=""`·`aria-hidden` `<img>`라 이름이 새지 않지만
// (Shared.tsx:206-213), 자동화 탭은 앱 자신의 타륜 로고로 서고(WorkflowsView.tsx의
// `AgentManagerMark`) 그 로고 svg는 자기 `role="img"`와 `aria-label="Agent Manager 로고"`를
// 갖는다(Shared.tsx:97). `aria-hidden`을 아이콘 컴포넌트가 받아 쓰지 않으면 자동화 탭이
// "Agent Manager 로고 자동화"로 읽힌다 — 라벨 문구가 아니라 **이름의 구성**을 붙잡는다.
// 자동화 탭은 애드온에서 워크플로 화면으로 옮겨 갔으므로 그 자리는 워크플로 탭 줄에서 본다.
//
// 문구 검증(AM-253)과 배치 검증(AM-237 계열)과는 다른 축이다. 여기서는 한국어·영어 양쪽에서
// 접근성 이름이 라벨과 정확히 같은지, 그리고 타륜이 탭 자리에서 이웃 탭까지 번지던 놋빛
// 드롭섀도를 걷었는지(App.css `.agent-manager-mark .logo-mark { filter: none }`)를 함께 본다.
const TABS = [
  { anchor: "addons.tab.mcp", ko: "외부 MCP", en: "External MCP" },
  { anchor: "addons.tab.ssh", ko: "SSH", en: "SSH" },
  { anchor: "addons.tab.db", ko: "DB", en: "DB" },
  { anchor: "addons.tab.k8s", ko: "K8s", en: "K8s" },
  { anchor: "addons.tab.peers", ko: "AIA 대화", en: "AIA peers" },
  { anchor: "addons.tab.runners", ko: "분산처리", en: "Distributed runners" },
  { anchor: "addons.tab.index", ko: "인덱스", en: "Index" },
  { anchor: "addons.tab.cypress", ko: "Cypress", en: "Cypress" },
  { anchor: "addons.tab.mermaid", ko: "Mermaid", en: "Mermaid" },
  { anchor: "addons.tab.claude", ko: "Claude Code", en: "Claude Code" },
] as const;

/**
 * 버튼이 스크린리더에 읽히는 이름을 근사한다. `aria-label`이 있으면 그것이, 없으면 자손 중
 * 숨기지 않은 것들의 텍스트와 `aria-label`·`alt`가 이어 붙어 이름이 된다. 장식으로 둔
 * 아이콘은 `aria-hidden` 조상이 있어 여기서 빠진다.
 */
function accessibleName(element: Element): string {
  const own = element.getAttribute("aria-label");
  if (own) return own.trim();
  const parts: string[] = [];
  element.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child.getAttribute("aria-hidden") === "true") return;
    const label = child.getAttribute("aria-label") ?? child.getAttribute("alt");
    parts.push(label ? label : accessibleName(child));
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * 탭 줄의 버튼을 앵커 순서대로 넘긴다. `.then`에서 배열을 반환하면 Cypress가 그것을 다시
 * 감싸 버려 다음 체인에서 배열로 다루지 못한다 — 검사를 콜백 안에서 끝낸다.
 */
function withTabButtons(check: (buttons: Element[]) => void) {
  cy.get(".addons-view .settings-subtab-nav > button").should("have.length", TABS.length)
    .then(($buttons) => check(Array.from($buttons)));
}

describe("애드온 도구 탭 줄의 접근성 이름", () => {
  after(() => cy.restoreLanguage());

  it("한국어에서 탭 이름이 라벨 하나로만 읽히고 아이콘 표식이 새지 않는다", () => {
    cy.viewport(1280, 900);
    cy.visitApp();
    cy.openView("addons").should("be.visible");

    withTabButtons((buttons) => {
      buttons.forEach((button, index) => {
        const tab = TABS[index];
        expect(button.getAttribute("data-ui-anchor"), `${index}번 탭의 앵커`).to.equal(tab.anchor);
        // 아이콘이 이름에 섞이면 여기서 "Agent Manager 로고 자동화"처럼 앞뒤가 붙어 나온다.
        expect(accessibleName(button), `${tab.anchor}의 접근성 이름`).to.equal(tab.ko);
      });
    });
  });

  it("워크플로 자동화 탭은 타륜 표식을 장식으로 두고 드롭섀도를 걷는다", () => {
    cy.viewport(1280, 900);
    cy.visitApp();
    cy.openView("workflows").should("be.visible");

    // 탭 이름도 같은 규칙이다 — 표식이 새면 "Agent Manager 로고 자동화"가 된다.
    cy.anchor("workflows.tab.automation").should(($button) => {
      expect(accessibleName($button[0]), "자동화 탭의 접근성 이름").to.equal("자동화");
    });

    cy.anchor("workflows.tab.automation").within(() => {
      // 표식이 실제로 서 있어야 한다 — 이름이 안 새는 이유가 "아이콘이 없어서"면 안 된다.
      cy.get(".agent-manager-mark").should("exist").and("have.attr", "aria-hidden", "true");
      cy.get(".agent-manager-mark svg.logo-mark")
        .should("exist")
        .and(($svg) => {
          // 로고는 자기 이름을 그대로 갖고 있고, 숨기는 일은 감싼 자리가 맡는다. 이 이름이
          // 실재해야 위 이름 검사가 의미를 갖는다 — 감싼 자리의 aria-hidden이 빠지면 곧바로 샌다.
          expect($svg.attr("role"), "로고 svg의 role").to.equal("img");
          expect($svg.attr("aria-label"), "로고 svg의 이름").to.be.a("string").and.not.empty;
          // 56px 브랜드 자리 기준 놋빛 그림자는 13px 탭에서 이웃까지 번진다. 이 자리에서는 없다.
          expect(getComputedStyle($svg[0]).filter, "탭 자리 로고의 filter").to.equal("none");
        });
    });

    // 사이드바 브랜드 자리의 로고는 그대로 그림자를 갖는다 — 규칙이 전역으로 번지지 않았는지 본다.
    cy.get(".brand svg.logo-mark").should(($svg) => {
      expect(getComputedStyle($svg[0]).filter, "브랜드 자리 로고의 filter").to.not.equal("none");
    });
  });

  it("영어에서도 탭 이름이 라벨 하나로만 읽힌다", () => {
    cy.viewport(1280, 900);
    cy.visitApp();
    cy.setLanguage("en");
    cy.openView("addons").should("be.visible");

    withTabButtons((buttons) => {
      buttons.forEach((button, index) => {
        const tab = TABS[index];
        expect(accessibleName(button), `${tab.anchor}의 영어 접근성 이름`).to.equal(tab.en);
      });
    });
  });
});
