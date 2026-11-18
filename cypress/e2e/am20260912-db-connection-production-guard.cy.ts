/// <reference types="cypress" />
// 애드온 → 데이터베이스 탭(`DbConnectionsCard.tsx`)의 등록 편집기가 거는 두 가지 안전
// 경계를 본다. 이 탭은 2026-09-11 `2b103cb`로 새로 선 자리라 기존 스펙이 한 번도 열어
// 본 적이 없다.
//
// 1) 환경을 `운영`으로 고르면 쓰기 모드를 읽기 전용으로 되돌리고 잠근다
//    (DbConnectionsCard.tsx:314, 백엔드 c10_11과 짝). 화면이 먼저 막지 않으면 저장에서
//    백엔드 오류로만 알게 된다.
// 2) 최대 행은 백엔드 천장(5,000행, db_connections.rs:59)으로 깎인다. 화면 입력칸에는
//    상한이 없으므로 저장 뒤 목록 표시가 깎인 값을 보여 줘야 한다.
//
// 엔진은 SQLite로 고른다 — 파일 엔진이라 호스트·포트·사용자 칸이 사라지고, 실제 접속
// 없이도 등록 자체가 성립한다(격리 백엔드에는 DB 서버가 없다).
//
// 격리 백엔드는 스펙 사이에 살아 있으므로 마지막에 등록한 연결을 삭제해 원상 복구한다.
const NAME = "QA 격리 SQLite";
const FILE_PATH = "/tmp/am-qa-db-guard.sqlite";
const CEILING = 5000;

describe("데이터베이스 연결 등록의 운영 환경 잠금과 최대 행 천장", () => {
  it("운영을 고르면 쓰기 모드가 읽기 전용으로 잠기고, 최대 행은 천장으로 깎여 저장된다", () => {
    cy.visitApp();
    cy.openDbConnectionsTab();

    // 사전조건: 격리 백엔드에는 등록된 연결이 없다.
    cy.get(".db-connections-card .plugin-empty-state").should("contain.text", "등록된 연결이 없습니다");
    cy.openDbConnectionEditor();

    // 1) 파일 엔진은 호스트·포트·사용자를 묻지 않고, 데이터베이스 칸이 파일 경로가 된다.
    cy.dbConnectionField("엔진").find("select").select("sqlite");
    cy.get(".db-connection-editor label > span").then(($spans) => {
      const labels = Array.from($spans, (span) => span.textContent?.trim());
      expect(labels, "파일 엔진은 호스트를 묻지 않는다").to.not.include("호스트");
      expect(labels, "파일 엔진은 포트를 묻지 않는다").to.not.include("포트");
      expect(labels, "파일 엔진은 사용자를 묻지 않는다").to.not.include("사용자");
      expect(labels, "데이터베이스 칸이 파일 경로가 된다").to.include("파일 경로");
    });

    // 이 자리에서 SQLite인데도 자격증명 기본값(클라이언트 파일 참조)이 PostgreSQL 전용
    // ~/.pgpass 안내를 띄우는 것을 봤다. 표시 결함이라 여기서 붙잡지 않고 QA 티켓으로
    // 남긴다(DbConnectionsCard.tsx:330-333).

    // 2) 개발 환경에서는 쓰기 모드를 고를 수 있다.
    cy.dbConnectionField("쓰기 모드").find("select").should("be.enabled").select("dmlWithApproval");
    cy.get(".db-connection-editor").should("not.contain.text", "운영으로 표시한 연결에는");

    // 3) 운영으로 바꾸는 순간 읽기 전용으로 되돌아가고 잠긴다.
    cy.dbConnectionField("환경").find("select").select("production");
    cy.dbConnectionField("쓰기 모드").find("select")
      .should("have.value", "readOnly")
      .and("be.disabled");
    cy.get(".db-connection-editor").should("contain.text", "운영으로 표시한 연결에는 쓰기 모드를 설정할 수 없습니다");

    // 4) 천장을 넘는 최대 행을 넣고 저장한다. 화면은 막지 않지만 저장값은 깎여야 한다.
    cy.dbConnectionField("이름").find("input").clear().type(NAME);
    cy.dbConnectionField("파일 경로").find("input").clear().type(FILE_PATH);
    cy.dbConnectionField("최대 행").find("input").clear().type("9999");
    cy.dbConnectionAction("저장").should("be.enabled").click();

    // 5) 목록에 운영·읽기 전용으로 서고, 최대 행은 천장으로 깎여 있다.
    cy.get(".db-connection-editor").should("not.exist");
    cy.get(".db-connection-row").should("have.length", 1).within(() => {
      cy.get(".db-connection-head").should("contain.text", NAME)
        .and("contain.text", "SQLite")
        .and("contain.text", "운영")
        .and("contain.text", "읽기 전용");
      cy.get(".db-connection-target").should("have.text", FILE_PATH);
      cy.get(".db-connection-meta").should("contain.text", `최대 ${CEILING}행`);
      // 등록 직후 에이전트 사용은 꺼져 있다 — 켜야만 에이전트가 조회한다.
      cy.get(".db-connection-toggle input").should("not.be.checked");
    });

    // 6) 다른 탭을 다녀와도 저장된 값이 그대로 남는다(다시 읽어 오는 경로).
    cy.openAddonsView("ssh");
    cy.anchor("addons.ssh-content").should("be.visible");
    cy.openDbConnectionsTab();
    cy.get(".db-connection-row").should("have.length", 1);
    cy.get(".db-connection-meta").should("contain.text", `최대 ${CEILING}행`);
    cy.get(".db-connection-head").should("contain.text", "읽기 전용");

    // 7) 편집기로 다시 열어도 잠금이 유지된다(저장된 운영 연결).
    cy.contains(".db-connection-actions button", "편집").click();
    cy.dbConnectionField("쓰기 모드").find("select").should("have.value", "readOnly").and("be.disabled");
    cy.dbConnectionField("최대 행").find("input").should("have.value", String(CEILING));
    cy.dbConnectionAction("취소").click();

    // 8) 원상 복구 — 등록한 연결을 지워 뒤 스펙에 남기지 않는다.
    cy.contains(".db-connection-actions button", "삭제").click();
    cy.get('[role="dialog"]').should("contain.text", "연결을 삭제할까요?");
    cy.get('[role="dialog"]').contains("button", "삭제").click();
    cy.get(".db-connections-card .plugin-empty-state").should("contain.text", "등록된 연결이 없습니다");
  });
});

export {};
