/// <reference types="cypress" />
// AM-38: 세션 목록 툴바의 공급자 소스 탭·검색어·프로젝트 선택 계약을 본다.
// 기존 세션 스펙은 좁히기 칩(AM-1·AM-21)과 추가 필터 팝오버(AM-14)까지만 다뤘고,
// 소스 탭 네 개의 배타 선택과 검색어·프로젝트 선택의 잔존 계약은 다룬 적이 없다.
// 격리 백엔드는 세션이 0건이라 목록 내용 대신 툴바 자체의 계약을 확인한다.

const toolbar = () => cy.view("sessions").find("section.toolbar-card");
const sourceTabs = () => toolbar().find(".source-tabs button");
const search = () => toolbar().find("input.search-input");
const projectSelect = () => toolbar().find("select").first();

describe("세션 목록 소스 탭과 검색어", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("sessions").should("be.visible");
  });

  it("공급자 탭 네 개가 선언한 순서로 나오고 처음에는 전체만 켜져 있다", () => {
    sourceTabs().should("have.length", 4);
    sourceTabs().then((list) => {
      expect([...list].map((el) => el.textContent?.trim())).to.deep.equal(["전체", "Claude", "Codex", "Antigravity"]);
    });
    sourceTabs().filter(".active").should("have.length", 1).and("have.text", "전체");
  });

  it("다른 공급자를 고르면 앞의 선택이 풀리고 하나만 켜진 채로 남는다", () => {
    sourceTabs().eq(2).click();
    sourceTabs().filter(".active").should("have.length", 1).and("have.text", "Codex");
    sourceTabs().eq(3).click();
    sourceTabs().filter(".active").should("have.length", 1).and("have.text", "Antigravity");
    // 같은 탭을 다시 눌러도 선택이 풀려 아무것도 없는 상태가 되지 않는다.
    sourceTabs().eq(3).click();
    sourceTabs().filter(".active").should("have.length", 1).and("have.text", "Antigravity");
  });

  it("세션이 0건이면 프로젝트 선택에 전체 항목만 있고 어떤 소스를 골라도 빈 안내가 나온다", () => {
    projectSelect().find("option").should("have.length", 1).and("have.text", "프로젝트 전체");
    projectSelect().should("have.value", "all");
    sourceTabs().eq(1).click();
    cy.view("sessions").should("contain.text", "조건에 맞는 세션이 없습니다");
    cy.view("sessions").find(".table-caption strong").should("have.text", "세션 0개");
  });

  it("검색어는 소스 탭을 바꿔도 지워지지 않는다", () => {
    search().should("have.attr", "placeholder", "제목·프로젝트·ID·메모 검색");
    search().type("존재하지-않는-세션-검색어");
    sourceTabs().eq(1).click();
    search().should("have.value", "존재하지-않는-세션-검색어");
    cy.view("sessions").should("contain.text", "조건에 맞는 세션이 없습니다");
  });

  it("소스 탭과 검색어는 다른 화면을 다녀와도 남지만 새로고침하면 전체·빈 검색어로 돌아간다", () => {
    sourceTabs().eq(2).click();
    search().type("잔존확인");
    cy.openView("dashboard").should("be.visible");
    cy.anchor("nav.sessions").click();
    cy.view("sessions").should("be.visible");
    sourceTabs().filter(".active").should("have.text", "Codex");
    search().should("have.value", "잔존확인");

    cy.reload();
    cy.openView("sessions").should("be.visible");
    sourceTabs().filter(".active").should("have.text", "전체");
    search().should("have.value", "");
  });
});
