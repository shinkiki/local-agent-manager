/// <reference types="cypress" />
/**
 * 프로젝트 화면 · 형상관리 탭 — 브랜치 폴더 트리(B4).
 *
 * 이름의 `/`를 폴더로 읽어 접고 편다. 기본은 접힘이고, 사용자가 펼친 폴더만 저장소별로
 * localStorage에 남는다. 여기서 못박는 것은 세 가지다.
 *  - 접힌 폴더의 브랜치 줄은 DOM에 없다(목록 길이가 접힘을 따른다).
 *  - 브랜치 하나뿐인 이름 공간은 폴더가 아니라 전체 이름을 단 줄 하나로 선다 — 폴더로
 *    두면 기본 접힘에서 그 브랜치가 화면에서 사라진다.
 *  - 팔로우 여부는 따로 선 카드가 아니라 그 줄의 표식과 방향 화살표가 말한다.
 */
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";
import { gitBranch, gitOverview, gitRepository, stubGitReads } from "../support/gitFixtures";

const panel = () => cy.get(".git-panel-shell");
const branches = () => panel().find(".git-branches");
const folder = (label: string) => branches().find(".git-branch-folder-toggle").contains(label);

const BRANCHES = {
  head: { branch: "develop", detached: false, unborn: false, sha: "0123456789abcdef0123456789abcdef01234567", shortSha: "0123456" },
  upstream: { name: "origin/develop", ahead: 1, behind: 2, gone: false },
  localBranches: [
    gitBranch("round/lane-L01", { upstream: "origin/round/lane-L01", behind: 3 }),
    gitBranch("develop", { isHead: true, upstream: "origin/develop", ahead: 1, behind: 2 }),
    gitBranch("round/lane-L02"),
  ],
  remoteBranches: [gitBranch("origin/develop")],
};

function openGitTab() {
  cy.visitApp();
  stubProjectRegistry([projectEntry("alpha")]);
  stubGitReads({ overview: gitOverview({ repository: gitRepository(BRANCHES) }) });
  cy.openProjectsView("git");
  cy.wait("@gitOverview");
  panel().find(".git-branch-name").should("contain", "develop");
}

describe("프로젝트 · 형상관리 탭 · 브랜치 폴더 트리", () => {
  beforeEach(openGitTab);

  it("폴더는 접힌 채로 서고 브랜치 하나뿐인 이름 공간은 폴더가 되지 않는다", () => {
    branches().find(".git-branch-scope.local .git-branch-scope-head").should("contain", "로컬 브랜치").and("contain", "3");
    branches().find(".git-branch-scope.remote .git-branch-scope-head").should("contain", "원격 브랜치").and("contain", "1");
    branches().find(".git-branch-scope.local .git-branch-list > :first-child").should("contain", "develop");
    // `round/` 두 개만 폴더다. `origin/develop`는 원격에 하나뿐이라 줄 하나로 선다.
    branches().find(".git-branch-folder-toggle").should("have.length", 1);
    folder("round").parents(".git-branch-folder").find("small").should("contain", "2");
    branches().find(".git-branch-row").should("have.length", 2);
    branches().find(".git-branch-row").should("contain", "develop").and("contain", "origin/develop");
    branches().should("not.contain", "lane-L01");
  });

  it("펼친 폴더는 다시 들어와도 펼쳐져 있고 일괄 접기가 한 번에 되돌린다", () => {
    folder("round").click();
    branches().find(".git-branch-row").should("have.length", 4);
    branches().find(".git-branch-row").should("contain", "lane-L01").and("contain", "lane-L02");

    // 펼침은 저장소별 키로 남는다. 탭을 다시 열어도 그대로여야 한다.
    cy.reload();
    stubProjectRegistry([projectEntry("alpha")]);
    stubGitReads({ overview: gitOverview({ repository: gitRepository(BRANCHES) }) });
    cy.openProjectsView("git");
    cy.wait("@gitOverview");
    branches().find(".git-branch-row").should("have.length", 4);

    branches().find(".git-branch-fold-all").click();
    branches().find(".git-branch-row").should("have.length", 2);
  });

  it("팔로우 중인 브랜치는 따로 선 카드가 아니라 그 줄의 표식과 방향 화살표로 보인다", () => {
    panel().find(".git-branch-follows").should("not.exist");
    panel().find(".git-branch-follow-card").should("not.exist");

    const head = () => branches().find(".git-branch-row.current");
    head().find(".git-branch-followed").should("exist");
    head().find(".git-branch-track .git-track-in").should("contain", "2");
    head().find(".git-branch-track .git-track-out").should("contain", "1");
    // 양쪽에 커밋이 있으므로 분기 상태다. 같은 기준(마지막 fetch)은 title에만 적는다.
    head().find(".git-branch-track.diverged").should("have.attr", "title").and("contain", "마지막 fetch 기준");

    // 받을 것만 있는 브랜치는 수신 화살표만 그린다.
    folder("round").click();
    branches().find(".git-branch-row").contains("lane-L01").parents(".git-branch-row").within(() => {
      cy.get(".git-track-in").should("contain", "3");
      cy.get(".git-track-out").should("not.exist");
    });
    // upstream이 없는 브랜치에는 표식도 화살표도 없다.
    branches().find(".git-branch-row").contains("lane-L02").parents(".git-branch-row").within(() => {
      cy.get(".git-branch-followed").should("not.exist");
      cy.get(".git-branch-track").should("not.exist");
    });
  });
});
