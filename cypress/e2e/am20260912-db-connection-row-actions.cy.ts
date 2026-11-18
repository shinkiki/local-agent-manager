/// <reference types="cypress" />
// 애드온 → 데이터베이스 탭(`DbConnectionsCard.tsx`) 목록 행의 세 조작을 본다. 기존 DB
// 스펙 셋(am20260912-db-connection-editor-bounds·engine-switch·production-guard)은
// 모두 등록 편집기만 열었고, 등록된 행의 '에이전트 사용' 토글과 '연결 확인' 버튼은
// 아무도 누른 적이 없다. 삭제도 승인 갈래만 원상 복구용으로 눌렸을 뿐 취소 갈래는 비어
// 있다.
//
// 축은 설정(애드온), 조건은 실패 응답의 오류 안내 + 확인 모달의 취소 갈래 + 새로고침 후 잔존.
// 확인하는 것:
//  1) 등록 직후 꺼져 있는 '에이전트 사용'을 켜면 즉시 저장되고 다시 읽어도 켜져 있다
//     (DbConnectionsCard.tsx:184, setDbConnectionEnabled).
//  2) 없는 SQLite 파일로 '연결 확인'을 누르면 실패 영수증이 그 행에 붙고 진단 문구가
//     보인다(db_exec.rs:105 check_db_connection → reachable=false).
//  3) 삭제 확인 모달을 취소하면 행이 그대로 남고, 취소로 busy가 풀려 다른 버튼이 다시
//     눌린다(run()이 confirm을 감싸고 있어 busy 해제가 빠지면 카드 전체가 잠긴다).
//  4) 붙잡힌 새로고침 응답이 그 사이 끝난 토글을 되돌리지 않는다.
//
// 엔진은 SQLite다 — 격리 백엔드에는 DB 서버가 없으므로 파일 엔진만 실제 접속 시도까지
// 간다. 파일 경로는 일부러 존재하지 않는 자리를 준다.
//
// 격리 백엔드는 스펙 사이에 살아 있으므로 마지막에 연결을 지워 원상 복구한다.
const NAME = "QA 격리 행조작 SQLite";
const FILE_PATH = "/tmp/am-qa-db-row-actions-missing.sqlite";

const row = () => cy.get(".db-connection-row").filter(`:contains(${NAME})`);

describe("데이터베이스 연결 행의 에이전트 사용 토글·연결 확인·삭제 취소", () => {
  it("토글은 다시 읽어도 유지되고, 없는 파일 확인은 실패 안내로, 삭제 취소는 행을 남긴다", () => {
    cy.visitApp();
    cy.openDbConnectionsTab();

    // 사전조건: 이 이름의 연결은 아직 없다(격리 백엔드는 스펙 사이에 살아 있다).
    cy.get(".db-connections-card").should("not.contain.text", NAME);
    cy.openDbConnectionEditor();
    cy.dbConnectionField("엔진").find("select").select("sqlite");
    cy.dbConnectionField("이름").find("input").clear().type(NAME);
    cy.dbConnectionField("파일 경로").find("input").clear().type(FILE_PATH);
    cy.dbConnectionAction("저장").should("be.enabled").click();
    cy.get(".db-connection-editor").should("not.exist");
    row().should("have.length", 1);

    // 1) 등록 직후엔 꺼져 있고, 켜면 그 자리에서 저장된다.
    row().find(".db-connection-toggle input").should("not.be.checked").click();
    row().find(".db-connection-toggle input").should("be.checked");

    // 화면 새로고침으로 다시 읽어도 켜진 채로 남는다(백엔드에 저장됐는지).
    cy.get(".db-connections-card .ssh-key-location").contains("button", "새로고침").click();
    row().find(".db-connection-toggle input").should("be.checked");

    // 다른 탭을 다녀와도 같다.
    cy.openAddonsView("ssh");
    cy.anchor("addons.ssh-content").should("be.visible");
    cy.openDbConnectionsTab();
    row().find(".db-connection-toggle input").should("be.checked");

    // 2) 없는 파일로 연결 확인 — 실패 영수증이 이 행에 붙는다.
    row().find(".db-connection-receipt").should("not.exist");
    row().contains(".db-connection-actions button", "연결 확인").click();
    row().find(".db-connection-receipt", { timeout: 15000 })
      .should("be.visible")
      .and("have.class", "failed")
      .and("not.contain.text", "접속 성공")
      .invoke("text")
      .should((message) => {
        expect(message.trim(), "실패 진단이 비어 있지 않다").to.not.equal("");
      });

    // 3) 삭제 확인 모달은 무엇이 지워지는지와 되돌릴 수 없다는 경고를 함께 보여 준다.
    row().contains(".db-connection-actions button", "삭제").click();
    cy.get('.modal[role="dialog"]').as("confirm").should("be.visible");
    cy.get("@confirm").find(".modal-title").should("contain.text", "연결을 삭제할까요?");
    cy.get("@confirm").find(".confirm-dialog p").first().should("contain.text", NAME);
    cy.get("@confirm").find(".confirm-dialog-warning").should("contain.text", "되돌릴 수 없습니다");
    // QA #73 수정 확인: 확인 버튼이 같은 애드온의 SSH 키 삭제(SshKeysCard.tsx:220)와 같은
    // 파괴적 동작 색(danger)으로 선다.
    cy.get("@confirm").find(".modal-footer button").last()
      .should("have.text", "삭제")
      .and("have.class", "danger")
      .and("not.have.class", "primary");

    // 취소하면 행이 그대로 남는다.
    cy.get("@confirm").find(".modal-footer button").first().should("have.text", "취소").click();
    cy.get('.modal[role="dialog"]').should("not.exist");
    row().should("have.length", 1);
    row().find(".db-connection-head").should("contain.text", NAME);

    // 취소로 busy가 풀렸는지 — 행 버튼들이 다시 눌린다.
    row().find(".db-connection-toggle input").should("be.enabled");
    row().contains(".db-connection-actions button", "연결 확인").should("be.enabled");
    row().contains(".db-connection-actions button", "편집").should("be.enabled").click();
    cy.get(".db-connection-editor").should("be.visible");
    // 편집기를 열면 직전 영수증은 지워진다(openEditor가 receipt를 비운다).
    cy.get(".db-connection-receipt").should("not.exist");
    cy.dbConnectionAction("취소").click();

    // 4) 늦게 온 목록 조회가 그 사이 끝난 토글을 덮지 않는다. 새로고침 응답을 붙잡아 둔
    //    채 토글을 끄면, 토글 전에 읽힌 '켜짐' 목록이 뒤늦게 와도 꺼진 채로 남아야 한다
    //    (DbConnectionsCard.tsx applyLatest — 덮이면 다음 토글이 같은 값을 다시 보낸다).
    cy.stubInvoke("get_db_connections", (req) => {
      req.continue((res) => { res.setDelay(2000); });
    }).as("slowList");
    row().find(".db-connection-toggle input").should("be.checked");
    cy.get(".db-connections-card .ssh-key-location").contains("button", "새로고침").click();
    row().find(".db-connection-toggle input").click();
    row().find(".db-connection-toggle input").should("not.be.checked");
    cy.wait("@slowList");
    // 꺼진 채인지만 보면 늦은 응답이 그려지기 전에 통과할 수 있다. 다음 토글이 실제로
    // '켜기'를 보내는지로 본다 — 낡은 목록이 덮었다면 다시 '끄기'를 보낸다.
    cy.stubInvoke("set_db_connection_enabled").as("toggleAgain");
    row().find(".db-connection-toggle input").click();
    cy.wait("@toggleAgain").its("request.body.request.enabled").should("eq", true);
    row().find(".db-connection-toggle input").should("be.checked");

    // 5) 원상 복구 — 승인 갈래로 지운다.
    row().contains(".db-connection-actions button", "삭제").click();
    cy.get('.modal[role="dialog"]').contains("button", "삭제").click();
    cy.get(".db-connections-card").should("not.contain.text", NAME);
  });
});

export {};
