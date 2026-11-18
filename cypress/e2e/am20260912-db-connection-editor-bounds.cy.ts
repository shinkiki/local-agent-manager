/// <reference types="cypress" />
// 애드온 → 데이터베이스 탭(2026-09-12 `2b103cb`로 신설)의 새 연결 편집기에서
// **저장 버튼의 필수값 경계와 초안의 수명**만 본다. 같은 날 다른 회차가 엔진 전환과
// 운영 환경 잠금·자격증명 출처를 각각 잡았으므로, 여기서는 그 축을 건드리지 않는다.
//
// 요점 셋이다. (1) 연결 0건인 격리 하네스에서도 등록 수단이 열려 있는가.
// (2) `isValid`(DbConnectionsCard.tsx:88)가 요구하는 이름·데이터베이스·호스트·사용자와
// MySQL 계열 클라이언트 파일 참조의 로그인 경로가 하나라도 공백이면 저장이 막히는가 —
// 공백만 채운 trim 경계 포함. (3) 취소로 닫은 초안이 다시 열 때 남지 않는가.
//
// 저장은 누르지 않는다. 이 스펙이 보는 것은 폼 경계이고, 등록을 남기면 같은 실행의
// 뒤따르는 스펙으로 상태가 샌다.
describe("데이터베이스 새 연결 편집기의 필수값 경계와 초안 수명", () => {
  const fillRequired = () => {
    cy.dbConnectionField("이름").find("input").type("qa-bounds");
    cy.dbConnectionField("데이터베이스").find("input").type("qa_db");
    cy.dbConnectionField("호스트").find("input").type("127.0.0.1");
    cy.dbConnectionField("사용자").find("input").type("qa_user");
    cy.dbConnectionField("로그인 경로").find("input").type("qa-login");
  };

  beforeEach(() => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openDbConnectionsTab();
  });

  it("연결 0건 빈 상태에서도 등록 수단이 열려 있고 다음 할 일을 알린다", () => {
    cy.get(".db-connection-list").should("not.exist");
    cy.get(".plugin-empty-state").should("contain.text", "등록된 연결이 없습니다");
    cy.get(".db-connections-card .ssh-key-location code").should("have.text", "0");
    // 호스트 화면이므로 원격 전용 잠금 안내는 서지 않고 등록이 눌린다.
    cy.get(".plugin-host-notice").should("not.exist");
    cy.anchor("addons.db.add").should("not.be.disabled");
    cy.get(".db-connection-editor").should("not.exist");
  });

  it("필수값이 하나라도 비면 저장이 막히고, 다 차면 열린다", () => {
    cy.openDbConnectionEditor();
    cy.dbConnectionAction("저장").should("be.disabled");

    // 하나씩 채우는 동안에는 계속 막혀 있어야 한다. 특히 MySQL 계열 + 클라이언트 파일
    // 참조는 로그인 경로까지 있어야 저장이 성립한다.
    cy.dbConnectionField("이름").find("input").type("qa-bounds");
    cy.dbConnectionAction("저장").should("be.disabled");
    cy.dbConnectionField("데이터베이스").find("input").type("qa_db");
    cy.dbConnectionAction("저장").should("be.disabled");
    cy.dbConnectionField("호스트").find("input").type("127.0.0.1");
    cy.dbConnectionAction("저장").should("be.disabled");
    cy.dbConnectionField("사용자").find("input").type("qa_user");
    cy.dbConnectionAction("저장").should("be.disabled");
    cy.dbConnectionField("로그인 경로").find("input").type("qa-login");
    cy.dbConnectionAction("저장").should("not.be.disabled");
  });

  it("공백만 남은 필수값은 trim 경계에서 다시 막힌다", () => {
    cy.openDbConnectionEditor();
    fillRequired();
    cy.dbConnectionAction("저장").should("not.be.disabled");

    // 눈으로는 채워 보이지만 trim하면 빈 값인 자리들. 하나씩 되돌려 확인한다.
    for (const label of ["이름", "데이터베이스", "호스트", "사용자", "로그인 경로"]) {
      cy.dbConnectionField(label).find("input").clear().type("   ");
      cy.dbConnectionAction("저장").should("be.disabled");
      cy.dbConnectionField(label).find("input").clear().type("qa");
      cy.dbConnectionAction("저장").should("not.be.disabled");
    }
  });

  it("취소로 닫은 초안은 다시 열 때 남지 않는다", () => {
    cy.openDbConnectionEditor();
    fillRequired();
    cy.dbConnectionField("메모").find("input").type("qa 회차 확인용");
    cy.dbConnectionAction("저장").should("not.be.disabled");

    cy.dbConnectionAction("취소").click();
    cy.get(".db-connection-editor").should("not.exist");
    // 닫힌 뒤에도 등록은 0건 그대로다 — 취소가 아무것도 남기지 않아야 한다.
    cy.get(".db-connections-card .ssh-key-location code").should("have.text", "0");
    cy.get(".plugin-empty-state").should("contain.text", "등록된 연결이 없습니다");

    cy.openDbConnectionEditor();
    cy.dbConnectionField("이름").find("input").should("have.value", "");
    cy.dbConnectionField("데이터베이스").find("input").should("have.value", "");
    cy.dbConnectionField("호스트").find("input").should("have.value", "");
    cy.dbConnectionField("사용자").find("input").should("have.value", "");
    cy.dbConnectionField("로그인 경로").find("input").should("have.value", "");
    cy.dbConnectionField("메모").find("input").should("have.value", "");
    cy.dbConnectionAction("저장").should("be.disabled");
  });

  it("다른 화면을 다녀와도 열어 둔 초안은 그대로 남는다", () => {
    cy.openDbConnectionEditor();
    fillRequired();
    cy.revisitView("addons");
    cy.anchor("addons.db-content").should("be.visible");

    // 편집 중이던 초안이 화면 전환으로 조용히 날아가면 입력을 잃는다.
    cy.get(".db-connection-editor").should("be.visible");
    cy.dbConnectionField("이름").find("input").should("have.value", "qa-bounds");
    cy.dbConnectionField("로그인 경로").find("input").should("have.value", "qa-login");
    cy.dbConnectionAction("저장").should("not.be.disabled");
  });
});

export {};
