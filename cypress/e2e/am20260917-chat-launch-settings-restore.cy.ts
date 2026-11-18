/// <reference types="cypress" />
/**
 * 새 채팅 시작 폼이 공급자별로 기억해 둔 모델을 복원하는 계약.
 *
 * 채팅 화면은 "지난번에 어떻게 두었는지"를 로컬 저장소 한 키에 공급자별로 담는다
 * (src/components/ChatLocalSettings.tsx:15 `agent-manager.chat-launch-settings`,
 * 읽기 :66, 쓰기 :75). 시작 폼은 그 값을 초기 상태로 읽고(src/components/ChatView.tsx:272)
 * 공급자를 바꿀 때마다 그 공급자의 저장값으로 갈아끼운다(:557). 저장된 식별자가 카탈로그에도
 * 최근 목록에도 없으면 모델 선택기가 '저장된 모델 식별자'로 덧붙여 보여 준다
 * (src/components/RuntimeSettings.tsx:96).
 *
 * 값의 모양 검사는 읽는 쪽이 한다 — JSON이 깨졌거나 model이 문자열이 아니면 빈 값으로
 * 흘려 '공급자 기본값'으로 돌아가야 한다(ChatLocalSettings.tsx:27, :67).
 *
 * 기존 채팅 축 스펙은 모델 선택기 팝오버의 열림·닫힘·선택 반영(am20260907-chat-model-picker)과
 * 최근 사용 모델의 순위·공급자 제외(am20260910-chat-recent-model-ranking)까지였다. 저장값이
 * 화면 밖(로컬 저장소)에서 들어와 복원되는 갈래와 손상된 저장값의 방어는 어느 스펙도 잡은
 * 적이 없다.
 *
 * 격리 하네스에 잡히는 공급자는 호스트 CLI 탐지에 따라 갈리므로 어느 공급자가 골라져
 * 있는지 전제하지 않는다. 세 공급자에 서로 다른 식별자를 심어 두고, 시작 폼이 고른
 * 공급자의 것만 실리는지 select 값으로 확인한다.
 */

const LAUNCH_SETTINGS_KEY = "agent-manager.chat-launch-settings";

const STORED_MODEL: Record<string, string> = {
  claude: "qa-stored-claude-model",
  codex: "qa-stored-codex-model",
  antigravity: "qa-stored-antigravity-model",
};

function seedLaunchSettings(value: unknown | string): Record<string, string> {
  return { [LAUNCH_SETTINGS_KEY]: typeof value === "string" ? value : JSON.stringify(value) };
}

function launchForm() {
  return cy.get(".chat-launch-form");
}

function providerSelect() {
  return launchForm().contains("label > span", /^공급자$/).parent().find("select");
}

function modelTrigger() {
  return launchForm().find(".model-picker-trigger");
}

describe("새 채팅 시작 폼의 공급자별 모델 기억 복원", () => {
  it("고른 공급자에 저장해 둔 모델 식별자를 트리거에 싣고 새로고침 뒤에도 유지한다", () => {
    cy.visitApp(seedLaunchSettings({
      claude: { model: STORED_MODEL.claude, reasoningEffort: "" },
      codex: { model: STORED_MODEL.codex, reasoningEffort: "" },
      antigravity: { model: STORED_MODEL.antigravity, reasoningEffort: "" },
    }));
    cy.openView("chat");
    launchForm().should("be.visible");

    providerSelect().invoke("val").then((selected) => {
      const expected = STORED_MODEL[String(selected)];
      expect(expected, `심어 둔 공급자(${selected})의 저장값`).to.be.a("string");
      modelTrigger().should("contain.text", expected).and("not.contain.text", "공급자 기본값");

      // 카탈로그에도 최근 목록에도 없는 식별자이므로 목록에 '저장된 모델 식별자'로 덧붙는다.
      modelTrigger().click();
      cy.get(".model-picker-popover .model-picker-list")
        .contains('button[role="option"]', expected)
        .should("have.attr", "aria-selected", "true")
        .and("contain.text", "저장된 모델 식별자");
      cy.get("body").type("{esc}");

      // 저장값은 화면 밖에 있으므로 다시 띄워도 같은 값이 실린다.
      cy.visitApp();
      cy.openView("chat");
      launchForm().should("be.visible");
      providerSelect().should("have.value", String(selected));
      modelTrigger().should("contain.text", expected);
    });
  });

  it("공급자를 바꾸면 그 공급자에 저장된 모델로 갈아끼운다", () => {
    cy.visitApp(seedLaunchSettings({
      claude: { model: STORED_MODEL.claude, reasoningEffort: "" },
      codex: { model: STORED_MODEL.codex, reasoningEffort: "" },
      antigravity: { model: STORED_MODEL.antigravity, reasoningEffort: "" },
    }));
    cy.openView("chat");
    launchForm().should("be.visible");

    providerSelect().find("option").then((options) => {
      const values = [...options].map((option) => (option as HTMLOptionElement).value);
      providerSelect().invoke("val").then((current) => {
        const other = values.find((value) => value !== String(current));
        if (!other) {
          // 호스트에 CLI가 한 종만 잡히면 바꿀 공급자가 없다. 그 경우 지금 공급자의
          // 저장값이 그대로 남아 있는 것까지만 본다.
          modelTrigger().should("contain.text", STORED_MODEL[String(current)]);
          return;
        }
        providerSelect().select(other);
        modelTrigger().should("contain.text", STORED_MODEL[other]);
        providerSelect().select(String(current));
        modelTrigger().should("contain.text", STORED_MODEL[String(current)]);
      });
    });
  });

  it("깨진 JSON·문자열이 아닌 model이 담겨 있으면 무시하고 공급자 기본값으로 돌아간다", () => {
    cy.visitApp(seedLaunchSettings("{not-json"));
    cy.openView("chat");
    launchForm().should("be.visible");
    modelTrigger().should("contain.text", "공급자 기본값");

    cy.visitApp(seedLaunchSettings({
      claude: { model: 12, reasoningEffort: 3 },
      codex: { model: null, reasoningEffort: [] },
      antigravity: { model: { id: "x" }, reasoningEffort: {} },
    }));
    cy.openView("chat");
    launchForm().should("be.visible");
    modelTrigger().should("contain.text", "공급자 기본값");
    Object.values(STORED_MODEL).forEach((model) => modelTrigger().should("not.contain.text", model));
  });
});
