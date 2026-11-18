/// <reference types="cypress" />
// 애드온 → 데이터베이스 연결 편집기(`DbConnectionsCard.tsx`)는 엔진에 따라 칸 구성이
// 갈린다. SQLite는 파일 하나로 끝나므로 호스트·포트·사용자가 없고(`isFileEngine`),
// "데이터베이스" 칸은 "파일 경로"가 된다. 자격증명 쪽도 갈리는데, MySQL 계열만
// `~/.mylogin.cnf`의 로그인 경로 이름을 받고(`usesLoginPath`) 나머지는 `~/.pgpass`
// 안내를 보여 준다.
//
// AM-265는 환경(운영) ↔ 쓰기 모드 잠금을, AM-267은 자격증명 출처와 비밀번호 비노출을
// 본다. 여기서는 그 둘과 겹치지 않게 **엔진 전환에 따른 조건부 칸 구성과 저장 가능
// 조건**만 붙잡는다. 엔진을 오갔을 때 칸이 다시 나타나고 기본 포트가 그 엔진 값으로
// 돌아오는지, 숨은 칸의 옛 값이 저장 버튼 판정에 남지 않는지가 요점이다.
//
// 격리 백엔드는 임시 app-data를 쓰므로 여기서 무엇을 입력하든 운영 연결에 닿지 않는다.
// 저장은 누르지 않는다 — 이 스펙은 편집기 상태만 본다.
describe("데이터베이스 연결 편집기 · 엔진 전환에 따른 칸 구성", () => {
  it("SQLite를 고르면 호스트·포트·사용자가 사라지고 파일 경로만 남으며, 되돌리면 기본 포트가 복원된다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openDbConnectionsTab();
    cy.openDbConnectionEditor();

    // 1) 기본값은 MariaDB다 — 서버 엔진이므로 호스트·포트·사용자가 모두 있고
    //    기본 포트가 3306으로 채워져 있다.
    cy.dbConnectionField("엔진").find("select").should("have.value", "mariadb");
    cy.dbConnectionField("호스트").find("input").should("exist");
    cy.dbConnectionField("사용자").find("input").should("exist");
    cy.dbConnectionField("포트").find("input").should("have.value", "3306");
    cy.dbConnectionField("데이터베이스").should("exist");
    cy.get(".db-connection-editor").should("not.contain.text", "파일 경로");

    // 2) MySQL 계열이라 자격증명 기본값(클라이언트 파일 참조)은 로그인 경로 이름을 받는다.
    cy.dbConnectionField("자격증명").find("select").should("have.value", "clientFile");
    cy.dbConnectionField("로그인 경로").find("input").should("exist");

    // 3) 서버 엔진에서는 이름과 데이터베이스만으로는 저장할 수 없다 — 호스트·사용자·
    //    로그인 경로가 비어 있기 때문이다(isValid).
    cy.dbConnectionField("이름").find("input").type("회차 점검용");
    cy.dbConnectionField("데이터베이스").find("input").type("qa_check");
    cy.dbConnectionAction("저장").should("be.disabled");

    // 4) PostgreSQL로 바꾸면 기본 포트가 그 엔진 값으로 바뀌고, 로그인 경로 칸 대신
    //    ~/.pgpass 안내가 선다. 호스트·사용자는 서버 엔진이라 그대로 남는다.
    cy.dbConnectionField("엔진").find("select").select("postgres");
    cy.dbConnectionField("포트").find("input").should("have.value", "5432");
    cy.get(".db-connection-editor").should("not.contain.text", "로그인 경로");
    cy.get(".db-connection-editor").should("contain.text", "~/.pgpass");
    cy.dbConnectionField("호스트").find("input").should("exist");

    // 5) SQLite는 파일 엔진이다 — 호스트·포트·사용자가 통째로 사라지고 "데이터베이스"
    //    칸은 "파일 경로"가 된다.
    //    ~/.pgpass 안내문에도 "호스트·포트·사용자"라는 말이 들어가므로 문구가 아니라
    //    입력 칸(label)의 유무로 본다.
    cy.dbConnectionField("엔진").find("select").select("sqlite");
    cy.contains(".db-connection-editor label", "호스트").should("not.exist");
    cy.contains(".db-connection-editor label", "포트").should("not.exist");
    cy.contains(".db-connection-editor label", "사용자").should("not.exist");
    cy.dbConnectionField("파일 경로").find("input").should("have.value", "qa_check");

    // 6) 파일 엔진은 이름과 경로만 있으면 저장할 수 있다. 숨어 있는 호스트·사용자의
    //    빈 값이 판정에 남으면 안 된다.
    cy.dbConnectionAction("저장").should("be.enabled");

    // 7) 다시 MySQL로 되돌리면 서버 칸이 돌아오고 포트는 그 엔진의 기본값으로 채워진다.
    //    저장은 다시 막힌다.
    cy.dbConnectionField("엔진").find("select").select("mysql");
    cy.dbConnectionField("포트").find("input").should("have.value", "3306");
    cy.dbConnectionField("호스트").find("input").should("exist").and("have.value", "");
    cy.dbConnectionField("로그인 경로").find("input").should("exist");
    cy.dbConnectionAction("저장").should("be.disabled");

    // 8) 취소하면 편집기가 닫히고 목록 자리로 돌아온다 — 임시 입력은 남지 않는다.
    cy.dbConnectionAction("취소").click();
    cy.get(".db-connection-editor").should("not.exist");
    cy.anchor("addons.db.add").should("be.visible");
  });

  // 아래는 기대 동작이 아니라 **지금 나오는 동작**을 붙잡아 둔 것이다. SQLite에는
  // 비밀번호 파일이 없는데도 자격증명 출처의 기본값(클라이언트 파일 참조)이 그대로
  // 남아 PostgreSQL용 `~/.pgpass` 안내가 선다. `usesLoginPath()`가 MySQL 계열이
  // 아닌 엔진을 모두 PostgreSQL로 취급하고, 파일 엔진을 따로 가르지 않기 때문이다
  // (`DbConnectionsCard.tsx:19-22,327-332`). 결함은 QA 티켓으로 등록했고, 고치는
  // 쪽이 이 단언을 "안내가 서지 않는다"로 뒤집으면 된다.
  it("SQLite에서도 자격증명 출처가 '클라이언트 파일 참조'로 남아 ~/.pgpass 안내가 선다 (현재 동작)", () => {
    cy.visitApp();
    cy.openDbConnectionsTab();
    cy.openDbConnectionEditor();

    cy.dbConnectionField("엔진").find("select").select("sqlite");
    cy.dbConnectionField("자격증명").find("select").should("have.value", "clientFile");
    cy.get(".db-connection-editor").should("contain.text", "~/.pgpass");
  });
});

export {};
