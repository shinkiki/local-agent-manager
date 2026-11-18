/// <reference types="cypress" />
import { cleanupDocRoot } from "../support/docRootFixtures";
// 문서 화면 "변경 자동화" 섹션의 등록된 트리거 목록 행.
// 기존 am20260908-doc-trigger-form-validation은 등록 폼의 기본값과 필수값 검증까지만 확인했고,
// 트리거가 실제로 등록된 뒤의 목록 행 표기는 어느 스펙도 다루지 않았다.
// 59072ad(문서 트리거 표시값 분기를 타입 검증 표로 모음)가 statusLabel의 switch를 Record 표로
// 바꿨으므로, 표시 문자열이 바뀌지 않았는지를 실제 화면에서 붙잡는다.
// 확인하는 것:
//  - 등록 직후 행 요약이 `등록 폴더명 · 새 채팅 · 활성`으로 보인다
//  - 스위치를 끄면 상태가 `일시중지`로 바뀌고 사유("사용자가 비활성화했습니다")가 함께 붙는다
//  - 탭을 떠났다 돌아와도(스냅숏 재조회) 일시중지 상태와 사유가 남는다
//  - 스위치를 다시 켜면 `활성`으로 돌아오고 사유 줄이 사라진다

describe("문서 변경 자동화 · 트리거 행의 상태 표기와 활성 스위치", () => {
  const targetDir = `/tmp/am-e2e-doctrigger-status-${Date.now()}`;
  const triggerName = "상태 표기 확인 트리거";
  const tabs = () => cy.view("docs").find(".docs-section-tabs button");
  const row = () => cy.get(".document-trigger-list article").first();

  before(() => {
    cy.exec(`mkdir -p ${targetDir}`);
  });

  after(() => {
    // 격리 백엔드라도 스펙 사이에 상태가 새므로(메모리: e2e-suite-state-leakage) 만든 것은 되돌린다.
    cy.request("POST", "/api/invoke/get_document_automation_snapshot", {}).then((res) => {
      const triggers = (res.body?.triggers ?? []) as Array<{ id: string; name: string }>;
      for (const trigger of triggers) {
        if (trigger.name === triggerName) {
          cy.request("POST", "/api/invoke/delete_document_trigger", { id: trigger.id });
        }
      }
    });
    cleanupDocRoot(targetDir);
  });

  it("등록된 트리거는 활성으로 시작하고, 스위치를 끄면 일시중지 사유까지 남는다", () => {
    cy.visitApp();
    cy.openView("docs").should("be.visible");

    // 1. 감시 대상 등록 폴더를 하나 만든다(트리거 등록의 사전조건).
    cy.get('[aria-label="등록 폴더 추가"]').first().click({ force: true });
    cy.get(".root-form input").eq(1).type(targetDir);
    cy.contains(".root-form button", "폴더 등록").click();
    cy.get(".root-form").should("not.exist");
    cy.get(".root-row").should("have.length", 1);

    // 2. 변경 자동화 탭으로 이동해 새 채팅 트리거를 등록한다.
    tabs().eq(1).click();
    cy.get(".document-trigger-form header strong").should("contain.text", "파일 트리거 등록");
    cy.get(".document-trigger-list .tree-empty").should("contain.text", "등록된 트리거가 없습니다.");

    cy.get(".document-trigger-grid input").first().type(triggerName);
    cy.get(".document-trigger-grid").last().find("select").first().select("startChat");
    cy.get(".document-trigger-form textarea").last().type("변경 파일을 검토하고 요약해줘");
    cy.get(".document-trigger-form-actions button.primary").click();

    // 3. 등록 직후 목록 행: 개수와 요약 문자열, 그리고 상태는 "활성".
    cy.get(".document-automation-panel .error-banner").should("not.exist");
    cy.get(".document-trigger-list header span").should("have.text", "1개");
    row().find("strong").should("have.text", triggerName);
    row().find("span").first().invoke("text").should((text: string) => {
      expect(text).to.contain("새 채팅");
      expect(text).to.contain("활성");
      expect(text).to.not.contain("일시중지");
    });
    // 활성 상태에서는 상태 사유 줄이 없다.
    row().find("small").should("not.exist");
    row().find(".app-toggle").should("have.attr", "aria-checked", "true");

    // 4. 스위치를 끄면 상태가 "일시중지"로 바뀌고 사유가 붙는다.
    row().find(".app-toggle").click();
    row().find("span").first().should("contain.text", "일시중지");
    row().find("small").should("contain.text", "사용자가 비활성화했습니다");
    row().find(".app-toggle").should("have.attr", "aria-checked", "false");

    // 5. 탭을 떠났다 돌아와 스냅숏을 다시 받아도 일시중지 상태가 남는다.
    tabs().eq(0).click();
    cy.get(".document-automation-panel").should("not.exist");
    tabs().eq(1).click();
    cy.get(".document-trigger-list header span").should("have.text", "1개");
    row().find("span").first().should("contain.text", "일시중지");
    row().find("small").should("contain.text", "사용자가 비활성화했습니다");
    row().find(".app-toggle").should("have.attr", "aria-checked", "false");

    // 6. 다시 켜면 "활성"으로 돌아오고 사유 줄이 사라진다.
    row().find(".app-toggle").click();
    row().find("span").first().should("contain.text", "활성");
    row().find("span").first().should("not.contain.text", "일시중지");
    row().find("small").should("not.exist");

    cy.screenshot("doc-trigger-status-toggle");
  });
});
