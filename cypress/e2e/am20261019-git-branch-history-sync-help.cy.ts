/// <reference types="cypress" />
/**
 * 프로젝트 화면 · 형상관리 탭 — 브랜치 이력 둘러보기와 원격 동기화 버튼 도움말.
 *
 * (1) 브랜치 목록에서 이름을 누르면 체크아웃 없이 `get_project_git_log`가 그 브랜치를
 * `reference`로 읽고, "현재 브랜치 이력으로"가 HEAD 로 되돌린다. (2) 동기화 버튼마다 아이콘과
 * 한 줄 설명이 붙고, 도움말 창의 mermaid 그림이 모두 그려진다(문법 오류로 원문이 남지 않는다).
 */
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";
import { GIT_PROJECT_PATH, gitCommit, stubGitReads } from "../support/gitFixtures";

const panel = () => cy.get(".git-panel-shell");
const logReference = (body: unknown) =>
  (JSON.parse(JSON.stringify(body)) as { request?: { reference?: string | null } }).request?.reference ?? null;

function openGitTab() {
  cy.visitApp();
  stubProjectRegistry([projectEntry("alpha")]);
  stubGitReads();
  // 기준 브랜치별로 다른 이력을 돌려준다. stubGitReads 의 이력 스텁을 덮어쓴다.
  cy.stubInvoke("get_project_git_log", (req) => {
    const reference = logReference(req.body);
    const commits = reference === "refs/heads/feature"
      ? [gitCommit("fffffff", "기능 브랜치에만 있는 커밋"), gitCommit("aaaaaaa", "첫 커밋")]
      : [gitCommit("aaaaaaa", "첫 커밋")];
    req.reply({ projectPath: GIT_PROJECT_PATH, reference: reference ?? "HEAD", commits, hasMore: false });
  }).as("gitLogByRef");
  cy.openProjectsView("git");
  cy.wait("@gitOverview");
  panel().find(".git-branch-name").should("contain", "main");
}

describe("프로젝트 · 형상관리 탭 · 브랜치 이력과 동기화 도움말", () => {
  beforeEach(() => {
    cy.on("window:confirm", () => { throw new Error("브라우저 confirm이 열렸다"); });
    openGitTab();
  });

  it("브랜치 이름을 누르면 전환하지 않고 그 브랜치의 이력을 보여 준다", () => {
    cy.stubInvoke("switch_project_git_branch", () => { throw new Error("이력 보기가 브랜치를 전환했다"); });
    cy.wait("@gitLogByRef").its("request.body").then((body) => expect(logReference(body)).to.equal(null));
    panel().find(".git-log-row").should("have.length", 1);
    panel().find(".git-branch-row.current").should("have.class", "viewing");

    panel().find(".git-branch-row").contains("feature").closest(".git-branch-row").find("button.git-branch-main").click();
    cy.wait("@gitLogByRef").its("request.body").then((body) => expect(logReference(body)).to.equal("refs/heads/feature"));
    panel().find(".git-log-row").should("have.length", 2).first().should("contain", "기능 브랜치에만 있는 커밋");
    panel().find(".git-log-viewing").should("contain", "feature");
    panel().find(".git-branch-row.viewing").should("have.length", 1).and("contain", "feature");
    panel().find(".git-branch-row.current").should("not.have.class", "viewing");
    // 체크아웃하지 않았으므로 머리의 현재 브랜치는 그대로다.
    panel().find(".git-branch-name").should("contain", "main");

    panel().find(".git-log button").contains("현재 브랜치 이력으로").click();
    cy.wait("@gitLogByRef").its("request.body").then((body) => expect(logReference(body)).to.equal(null));
    panel().find(".git-log-row").should("have.length", 1);
    panel().find(".git-log-viewing").should("not.exist");
  });

  it("동기화 버튼마다 아이콘·설명이 있고 도움말 창의 그림이 모두 그려진다", () => {
    for (const label of ["새로고침", "원격 확인", "받아서 합치기", "올리기", "브랜치 위로 옮기기", "도움말"]) {
      panel().find(".git-overview-actions button").contains(label).closest("button").then(($button) => {
        expect($button.find("svg"), `${label} 아이콘`).to.have.length.at.least(1);
        expect($button.attr("title"), `${label} 설명`).to.be.a("string").and.not.be.empty;
      });
    }
    panel().find(".git-overview-actions button").contains("원격 확인").closest("button").find(".git-action-term").should("have.text", "fetch");

    panel().find(".git-overview-actions button").contains("도움말").click();
    // 본문은 창 안에서 스크롤되는 긴 문서라 Cypress 의 '보임' 판정 대신 창 머리와 내용으로 본다.
    cy.get(".modal .modal-header").should("be.visible").and("contain", "원격 동기화 버튼 도움말");
    cy.get(".modal .git-sync-help").should("contain", "한눈에 보기").and("contain", "git fetch --prune");
    cy.get(".modal .git-sync-help .markdown-mermaid").should("have.length", 5);
    cy.get(".modal .git-sync-help .markdown-mermaid[data-state='ready']", { timeout: 20000 }).should("have.length", 5);
    cy.get(".modal .git-sync-help .markdown-mermaid[data-state='invalid']").should("not.exist");
    cy.get(".modal").screenshot("git-sync-help");
    cy.get("body").type("{esc}");
    cy.get(".modal .git-sync-help").should("not.exist");
  });
});
