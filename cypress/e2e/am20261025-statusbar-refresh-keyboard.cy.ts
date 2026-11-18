/// <reference types="cypress" />
import {
  accountUsage,
  providerAccount,
  providerState,
  stubLocalLlmDisconnected,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";
// 상태바 자체가 Enter·Space로 접힘·펼침을 뒤집지만, 그 안의 새로고침 버튼에서 올라온 키는
// 버튼 자신의 누름이다. footer가 그것까지 받아 preventDefault하면 키보드로는 새로고침이
// 되지 않고 밀도만 뒤집혔다.

const STATUSBAR = ".app-statusbar";

describe("상태바 새로고침 버튼의 키보드 누름", () => {
  beforeEach(() => {
    stubLocalLlmDisconnected();
    const codex = providerAccount({ usage: accountUsage({ windows: [{ label: "5시간", usedPercent: 40, resetsAt: null }] }) });
    stubProviderAccounts([providerState({ activeAccountId: codex.id })], [codex]);
  });

  it("새로고침 버튼에서 누른 Enter·Space는 상태바 밀도를 바꾸지 않고 기본 동작을 막지 않는다", () => {
    cy.visitApp();
    cy.view("dashboard").should("exist");
    cy.get(STATUSBAR).should("have.attr", "aria-expanded", "false");

    for (const key of ["Enter", " "]) {
      cy.get(".statusbar-refresh").then(($button) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        $button[0].dispatchEvent(event);
        expect(event.defaultPrevented, `${JSON.stringify(key)} 기본 동작`).to.equal(false);
      });
      cy.get(STATUSBAR).should("have.attr", "aria-expanded", "false");
    }

    // 상태바 자신에서 누른 Enter는 여전히 뒤집는다.
    cy.get(STATUSBAR).focus().trigger("keydown", { key: "Enter" });
    cy.get(STATUSBAR).should("have.attr", "aria-expanded", "true");
  });
});
