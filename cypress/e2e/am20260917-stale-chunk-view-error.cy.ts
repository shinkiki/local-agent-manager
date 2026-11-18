/// <reference types="cypress" />
// 재배포로 화면 청크가 사라진 셸에서의 오류 안내. 화면 번들은 lazy로 내려받으므로(App.tsx:136)
// 옛 셸이 없어진 해시 자산을 요청하면 동적 import가 실패한다. 이때 ErrorBoundary는 코드 결함이
// 아니라 "셸이 낡았다"로 판정해 새로고침을 시도하고(ErrorBoundary.tsx:43), 60초 안에 이미 그
// 이유로 새로고침한 적이 있으면 무한 새로고침 가드가 막아(appReload.ts:shouldReloadForStaleShell)
// 안내 화면이 남는다. 남은 화면은 scope="view"라 "다른 메뉴는 계속 사용할 수 있습니다"를 말해야
// 하고, 다시 시도로는 복구되지 않으므로 그 버튼이 없어야 한다.
import { seedHarnessStorage } from "../support/appCommands";

const STALE_SHELL_RELOAD_KEY = "agent-manager.stale-shell-reload";

describe("사라진 화면 청크를 만난 옛 셸의 오류 안내", () => {
  it("저장소 화면 청크가 404면 셸 낡음 안내가 서고 다른 메뉴는 계속 열린다", () => {
    cy.intercept("GET", "**/assets/StorageView-*.js", { statusCode: 404, body: "" }).as("staleChunk");
    cy.visit("/", {
      onBeforeLoad: (win) => {
        seedHarnessStorage(win);
        // 가드를 미리 채워 새로고침을 막는다. 막지 않으면 창이 다시 떠 안내 화면을 볼 수 없다.
        win.sessionStorage.setItem(STALE_SHELL_RELOAD_KEY, String(Date.now()));
      },
    });

    cy.anchor("nav.dashboard").should("be.visible");
    cy.anchor("nav.storage").click();
    cy.wait("@staleChunk");

    cy.get(".view-error", { timeout: 20000 }).should("be.visible").within(() => {
      cy.get("strong").should("contain.text", "새 버전이 배포되어");
      cy.get("p").should("contain.text", "다른 메뉴는 계속 사용할 수 있습니다");
      // 청크가 없는 상태는 다시 그린다고 복구되지 않는다. 새로고침 하나만 남아야 한다.
      cy.contains("button", "다시 시도").should("not.exist");
      cy.contains("button", "새로고침").should("be.visible");
    });
    cy.get(".view-error").should("have.attr", "role", "alert").and("have.attr", "data-error-scope", "view");
    // 셸 전체가 아니라 화면 하나만 떨어졌다는 표시.
    cy.get(".view-error").should("not.have.class", "view-error-app");
    cy.screenshot("am-stale-chunk-view-error");

    // 셸은 살아 있어야 한다 — 사이드바와 다른 메뉴가 그대로 동작한다. 떠난 화면은 DOM에
    // 남은 채 숨겨지므로 "보이는 오류 안내가 없다"로 본다.
    cy.get(".app-sidebar nav").should("be.visible");
    cy.openView("skills");
    cy.view("skills").find(".view-error").should("not.exist");
    cy.get(".view-error:visible").should("not.exist");
  });
});
