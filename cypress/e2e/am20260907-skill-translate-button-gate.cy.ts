/// <reference types="cypress" />
// 보관 스킬 상세 드로어 머리의 '리소스 번역' 버튼(TranslateResourceButton)이 시스템
// 에이전트 없이 어떻게 보이는지. 격리 하네스는 계정·CLI 연결이 비어 있어
// `automation.settings.systemProvider`가 없고, 그러면 이 버튼은 눌러도 같은 오류만
// 돌려주므로 사유를 달고 잠긴다(src/components/TranslationProgress.tsx:33).
//
// 기존 스킬 스펙 넷(AM-40 필터 칩, 일괄 작업 바 둘, 휴지통)은 목록 쪽만 봤고, 번역
// 스펙들(메뉴 카탈로그·언어 전환)은 화면 UI 언어만 봤다. 리소스 단위 번역 버튼의
// 접근 통제와 버튼이 아예 없는 조건은 아직 어느 시나리오도 확인하지 않았다.
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/amxlate");

// alpha: 보관 원본이 있어 번역 대상 ID(common.id)가 잡힌다.
// beta:  보관 원본도 없고 설치본 skillId도 null이라 번역 대상이 하나도 없다.
const LIBRARY = library([
  entry("alpha", { common: true, providers: [providerState("claude")] }),
  entry("beta", { common: false, providers: [providerState("codex", { skillId: null })] }),
]);

function openDrawer(name: string) {
  cy.stubInvoke("get_skill_library", LIBRARY);
  openSkillLibrary();
  cy.get(".skill-library-row").contains(name).click();
  return cy.get(".drawer");
}

const translateButton = () => cy.get(".drawer-header-actions button").not('[aria-label="닫기"]');

describe("시스템 에이전트가 없을 때 보관 스킬 드로어의 리소스 번역 버튼", () => {
  it("번역 대상이 있는 스킬은 버튼이 뜨지만 잠기고 사유를 달고 있다", () => {
    openDrawer("alpha");

    // 1) 아직 번역본이 없으므로 라벨은 '재번역'이 아니라 '번역'이다.
    translateButton().should("have.length", 1).and("have.text", "번역");

    // 2) 시스템 에이전트가 없으니 눌리지 않고, 이유가 title에 실린다.
    translateButton()
      .should("be.disabled")
      .and("have.attr", "title", "먼저 CLI가 연결된 시스템 에이전트를 선택하세요.");
  });

  it("번역 대상 ID가 하나도 없는 스킬은 버튼 자체가 없다", () => {
    openDrawer("beta");

    // 3) 보관 원본도 설치본 ID도 없으면 번역할 리소스를 가리킬 수 없다.
    cy.get(".drawer").should("be.visible");
    translateButton().should("have.length", 0);
  });

  it("잠긴 버튼을 눌러도 번역 요청이 나가지 않는다", () => {
    cy.stubInvoke("translate_resource").as("translate");
    openDrawer("alpha");

    // 4) force로 눌러도 disabled 버튼은 onClick을 타지 않는다.
    translateButton().click({ force: true });
    cy.wait(300);
    cy.get("@translate.all").should("have.length", 0);
  });
});
