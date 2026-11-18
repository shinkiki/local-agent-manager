/**
 * 설정 → AIA 설정의 'AIA 선제 제안 팩' 카드 계약.
 *
 * AM-246은 설정 → AIA 설정 탭의 제안 팩 on/off 토글만 봤고, d802fae 커밋이 "설치한 팩과
 * 관리 화면은 일부러 그대로 두었다"고 적은 그 관리 화면 자체는 어느 시나리오도 확인하지
 * 않았다. AM-40·AM-58·AM-87은 (카드가 예전에 얹혀 있던) 스킬 보관함의 필터바만 다뤘다.
 *
 * 파일 이름은 등록된 시나리오 id와 묶여 있어 그대로 둔다 — 카드는 스킬 → 스킬관리에서
 * 애드온 → 자동화를 거쳐 설정 → AIA 설정으로 옮겨졌고, 켜고 끄는 스위치도 같은 자리에 선다.
 *
 * 축은 스킬, 조건은 되묻기(확인 모달)의 취소 갈래 + 다국어 전환.
 * 확인하는 것:
 *  - 미설치 상태에서 '공통 스킬로 복사' 버튼이 열려 있고 제안 개수가 카탈로그와 맞는다
 *  - 누르면 네이티브 confirm이 아니라 앱 공용 확인 모달이 뜬다
 *  - 모달을 취소하거나 Esc로 닫으면 create_common_skill·update_common_skill이 나가지 않는다
 *  - 영어로 바꾸면 이 카드의 문구도 함께 영어로 바뀐다(QA #70 수정 확인)
 */
const BUNDLED_KEY = "aia-suggestion-pack";

function definition(id: string) {
  return {
    packId: "bundled",
    packDisplayName: "기본 제안 팩",
    skillKey: null,
    definition: { id, title: `제안 ${id}`, body: "" },
  };
}

const CATALOG = {
  contentDigest: "qa-digest",
  packs: [],
  definitions: [definition("alpha"), definition("beta"), definition("gamma")],
  issues: [],
  bundledSkill: {
    key: BUNDLED_KEY,
    name: "AIA 선제 제안 팩",
    description: "제안 문구와 명령 초안",
    files: [{ path: "SKILL.md", content: "# 제안 팩" }],
    installed: false,
  },
};

function card() {
  return cy.get(".aia-suggestion-pack-card");
}

function copyButton() {
  return card().contains("button", "공통 스킬로 복사");
}

function dialog() {
  return cy.get('.modal[role="dialog"]');
}

function openSuggestionPanel() {
  cy.visitApp();
  cy.window().then((win) => { cy.stub(win, "confirm").as("nativeConfirm").returns(false); });
  cy.openSettingsTab("aia");
  card().should("be.visible");
}

describe("AIA 설정 선제 제안 팩 카드의 복사 되묻기와 다국어", () => {
  beforeEach(() => {
    cy.stubInvoke("get_aia_suggestion_catalog", { statusCode: 200, body: CATALOG });
    // 복사 경로의 두 IPC는 막아 두고 "누르지 않았는데 나갔는지"까지 센다.
    cy.stubInvoke("create_common_skill", { statusCode: 200, body: { key: BUNDLED_KEY, contentDigest: "qa-digest" } }).as("createCommon");
    cy.stubInvoke("update_common_skill", { statusCode: 200, body: { key: BUNDLED_KEY, contentDigest: "qa-digest" } }).as("updateCommon");
  });

  after(() => {
    cy.restoreLanguage();
  });

  it("미설치 상태에서 카드가 제안 개수와 함께 열리고 복사 버튼이 활성이다", () => {
    openSuggestionPanel();
    card().find(".section-title h3").should("contain.text", "AIA 선제 제안 팩");
    card().find(".section-title span").should("have.text", "3개 제안");
    card().find("code").should("have.text", BUNDLED_KEY);
    copyButton().should("not.be.disabled");
    card().find(".aia-suggestion-pack-issues").should("not.exist");
  });

  it("복사 버튼은 브라우저 confirm 대신 앱 확인 모달을 띄우고, 취소하면 아무 IPC도 나가지 않는다", () => {
    openSuggestionPanel();
    copyButton().click();

    cy.get("@nativeConfirm").should("not.have.been.called");
    dialog().should("be.visible");
    dialog().find(".modal-title").should("contain.text", "AIA 제안 팩 복사");
    dialog().find(".confirm-dialog p").first().should("have.text", "앱 기본 제안 팩을 사용자가 편집할 수 있는 공통 스킬로 복사할까요?");
    dialog().find(".modal-footer button").last().should("have.text", "공통 스킬로 복사").and("not.have.class", "danger");

    dialog().find(".modal-footer button").first().should("have.text", "취소").click();
    dialog().should("not.exist");
    cy.get("@createCommon").should("not.exist");
    cy.get("@updateCommon").should("not.exist");
    copyButton().should("not.be.disabled");
  });

  it("모달을 Esc로 닫아도 복사가 실행되지 않는다", () => {
    openSuggestionPanel();
    copyButton().click();
    dialog().should("be.visible");
    cy.get("body").type("{esc}");
    dialog().should("not.exist");
    cy.get("@createCommon").should("not.exist");
    cy.get("@updateCommon").should("not.exist");
  });

  it("UI 언어를 영어로 바꾸면 이 카드의 문구도 함께 영어가 된다", () => {
    cy.visitApp();
    cy.setLanguage("en");
    cy.openSettingsTab("aia");
    card().should("be.visible");
    // QA #70. 예전에는 이 카드만 한국어 리터럴이라 영어 UI에서 통째로 한국어로 남았다.
    card().find(".section-title h3").should("contain.text", "AIA proactive suggestion pack")
      .and("not.contain.text", "선제 제안 팩");
    card().find(".section-title span").should("have.text", "3 suggestions");
    card().find("p").should("contain.text", "Manage suggestion wording");
    card().contains("button", "Copy to common skills").should("exist");
  });
});
