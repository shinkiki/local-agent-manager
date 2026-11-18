/// <reference types="cypress" />
/**
 * 프로젝트 화면 · 형상관리 탭(ProjectGitPanel) — 조회 그리기와 변경 명령의 인자.
 *
 * 백엔드는 스텁이다. 스펙이 주장하는 것은 (1) 개요·상태 네 묶음이 계약대로 그려지는가,
 * (2) 체크박스·더 보기·리베이스가 **어떤 명령을 어떤 인자로** 보내고 그 뒤 개요·상태를 다시
 * 읽는가, (3) 밀어올리기·스태시 버리기·리베이스가 브라우저 confirm이 아니라 앱의
 * `.confirm-dialog`를 거치는가, (4) 충돌 영수증이 `.git-conflict-list`로 서고 `inProgress`가
 * 오면 계속·건너뛰기·중단이 뜨는가이다.
 */
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";
import {
  gitBranch,
  gitBranchComparison,
  gitCommit,
  gitCommitFiles,
  gitDiff,
  gitEntry,
  gitLog,
  gitOverview,
  gitReceipt,
  gitRepository,
  gitStatus,
  stubGitReads,
} from "../support/gitFixtures";

const panel = () => cy.get(".git-panel-shell");
const group = (id: string) => panel().find(`.git-change-group[data-group="${id}"]`);
const overviewButton = (label: string) => panel().find(".git-overview-actions button").contains(label);
const dialog = () => cy.get(".confirm-dialog");
const diffModal = () => cy.get(".modal:has(.git-diff-modal-body)");

const twoPageLog = (skip: number) => (skip === 0
  ? gitLog([gitCommit("aaaaaaa", "두 번째 커밋", { refs: ["HEAD -> main", "origin/main"] }), gitCommit("bbbbbbb", "첫 커밋")], true)
  : gitLog([gitCommit("ccccccc", "맨 처음 커밋")], false));
const fullSha = (shortSha: string) => `${shortSha}${"0".repeat(40 - shortSha.length)}`;
const LONG_DIFF = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,1 +1,120 @@",
  "-old",
  ...Array.from({ length: 120 }, (_, index) => `+line ${index + 1}`),
  "",
].join("\n");
const FULL_FILE_DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,7 +1,7 @@",
  " 파일 첫 줄 — 전체 보기에서만 보임",
  " 둘째 줄",
  " 셋째 줄",
  "-바꾸기 전",
  "+바꾼 뒤",
  " 다섯째 줄",
  " 여섯째 줄",
  " 파일 마지막 줄 — 전체 보기에서만 보임",
  "",
].join("\n");

function openGitTab() {
  cy.visitApp();
  stubProjectRegistry([projectEntry("alpha")]);
  stubGitReads({ log: twoPageLog });
  cy.openProjectsView("git");
  cy.wait("@gitOverview");
  cy.wait("@gitStatus");
  panel().find(".git-branch-name").should("contain", "main");
}

describe("프로젝트 · 형상관리 탭", () => {
  beforeEach(() => {
    cy.on("window:confirm", () => { throw new Error("브라우저 confirm이 열렸다"); });
    openGitTab();
  });

  it("개요·네 묶음·이력을 계약대로 그리고 커밋 버튼은 메시지가 있어야 열린다", () => {
    panel().find(".git-upstream").should("contain", "↑1").and("contain", "↓2");
    group("staged").should("contain", "a.ts");
    group("unstaged").should("contain", "b.ts");
    group("untracked").should("contain", "c.txt");
    group("conflicted").should("contain", "d.ts");
    panel().find(".git-branch-row").should("have.length", 3);
    panel().find(".git-branch-row.current").should("contain", "main");
    panel().find(".git-worktree-row").should("have.length", 1);
    panel().find(".git-stash-row").should("have.length", 1);

    // 스테이지 1개(a.ts)이므로 메시지만 있으면 열린다.
    const commitButton = () => panel().find(".git-commit-box .form-actions button");
    commitButton().should("be.disabled");
    panel().find(".git-commit-box textarea").type("고침");
    commitButton().should("not.be.disabled");

    // 이력 첫 페이지 2건, 더 보기는 skip: 2로 다음 페이지를 이어 붙인다.
    cy.wait("@gitLog");
    panel().find(".git-log-row").should("have.length", 2);
    panel().find(".git-log-columns").should("contain", "커밋 메시지").and("contain", "커밋 계정").and("contain", "커밋 시간");
    panel().find(".git-log-head").first().children().last().should("have.class", "git-log-pick");
    panel().find(".git-log button").contains("더 보기").click();
    cy.wait("@gitLog").its("request.body").then((body) => {
      expect(JSON.parse(JSON.stringify(body)).request.skip).to.equal(2);
    });
    panel().find(".git-log-row").should("have.length", 3);
  });

  /**
   * 2026-10-04 회귀. B8이 더한 `get_project_branch_comparison`은 head 브랜치에 upstream이
   * 있으면 조건 없이 나가는데, 공용 픽스처 `stubGitReads`에 그 스텁이 없어 거절로 끝났다.
   * 그러면 비교 칸이 `.error-banner`로 서고, 형상관리 탭을 여는 모든 스펙이 빨간 화면 위에서
   * 돈다 — 실제로 project-menu-overlay 스펙이 그 배너 때문에 깨져 있었다.
   *
   * 이 시험은 "스텁이 있다"가 아니라 **픽스처가 준 수신·송신이 화면에 그대로 선다**를 묻는다.
   * 스텁을 다시 빼면 여기서 먼저 멈춘다 — 배너 하나가 다른 스펙의 단언을 조용히 갉아먹는
   * 대신, 비교를 읽는 자리에서 사유가 드러나야 한다.
   */
  it("upstream 비교가 수신·송신으로 갈려 서고 조회 실패 배너가 뜨지 않는다", () => {
    cy.wait("@gitBranchComparison").its("request.body.request").should("deep.include", {
      projectPath: "/tmp/amproj/alpha",
      branch: "main",
      upstream: "origin/main",
    });
    panel().find(".git-branch-comparison .error-banner").should("not.exist");
    // 2026-10-20: 기본은 접힌 요약 바다. 칩이 수·갈라짐을 말하고, 펼쳐야 목록이 선다.
    const toggle = () => panel().find(".git-comparison-toggle");
    toggle().should("have.attr", "aria-expanded", "false");
    toggle().find(".git-comparison-chip.incoming").should("contain", "2");
    toggle().find(".git-comparison-chip.outgoing").should("contain", "1");
    toggle().find(".git-comparison-chip.diverged").should("have.attr", "title").and("contain", "fast-forward");
    panel().find(".git-comparison-side").should("not.exist");
    toggle().click();
    toggle().should("have.attr", "aria-expanded", "true");
    const side = (index: number) => panel().find(".git-comparison-side").eq(index);
    side(0).find("header strong").should("contain", "2");
    side(0).find(".git-comparison-commits li").should("have.length", 2).first().should("contain", "수신 커밋");
    side(0).find(".git-comparison-group h4").should("have.length", 2).last().should("contain", "바뀐 파일");
    side(0).find(".git-commit-file .git-change-path").should("contain", "a.ts");
    side(1).find("header strong").should("contain", "1");
    side(1).find(".git-comparison-commits li").should("have.length", 1).first().should("contain", "송신 커밋");
    side(1).find(".git-commit-file .git-change-path").should("contain", "b.ts");
    panel().find(".git-comparison-body .git-comparison-note").should("contain", "fast-forward");
    // 펼침은 저장소마다 기억한다.
    cy.window().its("localStorage").invoke("getItem", "agent-manager.git-comparison-open.v1").should("contain", "/tmp/amproj/alpha");
  });

  it("upstream과 같으면 펼쳐 둔 저장소에서도 요약 바 한 줄만 선다", () => {
    cy.wait("@gitBranchComparison");
    // 먼저 펼쳐 둔다 — 접힌 채로 시작하면 본문이 없다는 단언이 저절로 참이 된다.
    panel().find(".git-comparison-toggle").click();
    panel().find(".git-comparison-body").should("exist");
    // HEAD가 움직여야 비교를 다시 읽는다.
    stubGitReads({
      log: twoPageLog,
      overview: gitOverview({ repository: gitRepository({ head: { branch: "main", detached: false, unborn: false, sha: "1111111111111111111111111111111111111111", shortSha: "1111111" } }) }),
      comparison: gitBranchComparison({ incoming: [], outgoing: [], incomingCount: 0, outgoingCount: 0, incomingFiles: [], outgoingFiles: [], diverged: false }),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitBranchComparison");
    panel().find(".git-comparison-toggle").should("be.disabled").find(".git-comparison-chip.same").should("contain", "upstream과 같습니다");
    panel().find(".git-comparison-toggle").should("not.have.attr", "aria-expanded");
    panel().find(".git-comparison-body").should("not.exist");
    panel().find(".git-comparison-side").should("not.exist");
  });

  /**
   * 2026-10-17 회귀. 비교 결과를 값만 들고 있던 동안에는 브랜치를 바꾼 뒤 새 답이 오기
   * 전까지 이전 브랜치의 수신·송신 목록이 새 브랜치 이름 아래 그대로 섰고, 그 파일을
   * 누르면 새 브랜치 범위로 엉뚱한 diff를 열었다. 새 답이 늦게(8초 — 기본 단언 대기 4초보다 길게) 오는 동안 이전 목록이
   * 보이지 않아야 한다.
   */
  it("브랜치를 바꾸면 새 비교가 오기 전까지 이전 브랜치의 목록을 보이지 않는다", () => {
    cy.wait("@gitBranchComparison");
    panel().find(".git-comparison-toggle").click();
    panel().find(".git-comparison-side").should("have.length", 2);
    stubGitReads({
      log: twoPageLog,
      overview: gitOverview({
        repository: gitRepository({
          head: { branch: "feature", detached: false, unborn: false, sha: "abcdef0123456789abcdef0123456789abcdef01", shortSha: "abcdef0" },
          upstream: { name: "origin/feature", ahead: 0, behind: 0, gone: false },
          localBranches: [gitBranch("main", { upstream: "origin/main" }), gitBranch("feature", { isHead: true, upstream: "origin/feature" })],
        }),
      }),
    });
    cy.stubInvoke("get_project_branch_comparison", (req) => {
      req.reply({ delay: 8000, body: gitBranchComparison() });
    }).as("slowComparison");
    overviewButton("새로고침").click();
    cy.wait("@gitOverview");
    panel().find(".git-branch-comparison small").should("contain", "feature ↔ origin/feature");
    panel().find(".git-comparison-side").should("not.exist");
    panel().find(".git-branch-comparison").should("contain", "비교를 읽고 있습니다");
    cy.wait("@slowComparison");
    panel().find(".git-comparison-side").should("have.length", 2);
  });

  it("upstream이 없는 브랜치에서는 비교 칸 자체가 서지 않는다", () => {
    stubGitReads({
      log: twoPageLog,
      overview: gitOverview({
        repository: gitRepository({
          upstream: null,
          localBranches: [gitBranch("main", { isHead: true }), gitBranch("feature")],
        }),
      }),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitOverview");
    panel().find(".git-branch-comparison").should("not.exist");
    panel().find(".error-banner").should("not.exist");
  });

  it("체크박스는 stage_project_git_paths에 그 경로 하나만 보내고 개요·상태를 다시 읽는다", () => {
    cy.stubInvoke("stage_project_git_paths", gitReceipt()).as("stage");
    group("unstaged").find('input[type="checkbox"]').check();
    cy.wait("@stage").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.paths).to.deep.equal(["b.ts"]);
      expect(request.projectPath).to.equal("/tmp/amproj/alpha");
    });
    cy.wait("@gitOverview");
    cy.wait("@gitStatus");
    panel().find(".git-receipt.succeeded").should("exist");
  });

  it("C16 변경됨·추적 안 됨은 그룹 전체 선택을 제공하고 선택 해제는 스테이지를 내린다", () => {
    cy.stubInvoke("stage_project_git_paths", gitReceipt()).as("stageAll");
    cy.stubInvoke("unstage_project_git_paths", gitReceipt()).as("unstageAll");

    group("unstaged").find(".git-change-select-all").should("contain", "전체 선택").find('input[type="checkbox"]').check();
    cy.wait("@stageAll").its("request.body.request.paths").should("deep.equal", ["b.ts"]);

    group("untracked").find(".git-change-select-all").should("contain", "전체 선택").find('input[type="checkbox"]').check();
    cy.wait("@stageAll").its("request.body.request.paths").should("deep.equal", ["c.txt"]);

    group("staged").find(".git-change-select-all").should("contain", "전체 선택 해제").find('input[type="checkbox"]').uncheck();
    cy.wait("@unstageAll").its("request.body.request.paths").should("deep.equal", ["a.ts"]);
  });

  it("C16 변경 파일을 현재 목록과 접을 수 있는 폴더형 보기로 전환한다", () => {
    stubGitReads({
      log: twoPageLog,
      status: gitStatus([
        gitEntry("src/components/A.tsx", { worktreeStatus: "modified" }),
        gitEntry("src/lib/a.ts", { worktreeStatus: "modified" }),
        gitEntry("README.md", { worktreeStatus: "modified" }),
      ]),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitStatus");

    panel().find('.git-change-view-toggle button[aria-pressed="true"]').should("contain", "목록");
    group("unstaged").find(".git-change-folder").should("not.exist");
    panel().find(".git-change-view-toggle button").contains("폴더").click();
    panel().find('.git-change-view-toggle button[aria-pressed="true"]').should("contain", "폴더");
    group("unstaged").find(".git-change-folder-toggle").first().should("contain", "src").and("have.attr", "aria-expanded", "true");
    group("unstaged").find(".git-change-row").should("contain", "A.tsx").and("contain", "a.ts").and("contain", "README.md");

    group("unstaged").find(".git-change-folder-toggle").first().click();
    group("unstaged").find(".git-change-folder-toggle").first().should("have.attr", "aria-expanded", "false");
    group("unstaged").find(".git-change-row").should("have.length", 1).and("contain", "README.md");
    panel().find(".git-change-view-toggle button").contains("목록").click();
    group("unstaged").find(".git-change-row").should("contain", "src/components/A.tsx");
  });

  it("C16 이력 선택 열은 머리글과 같은 42px 폭을 써 커밋 시간과 겹치지 않는다", () => {
    cy.wait("@gitLog");
    panel().find(".git-log-columns").then(($columns) => {
      const heading = $columns[0].querySelector(".git-log-column-pick")!.getBoundingClientRect();
      panel().find(".git-log-row").first().find(".git-log-pick").then(($pick) => {
        const row = $pick[0].getBoundingClientRect();
        expect(row.width).to.equal(42);
        expect(Math.abs(row.left - heading.left), "선택 열 왼쪽 정렬").to.be.lessThan(1);
        panel().find(".git-log-row").first().then(($logRow) => {
          const time = $logRow[0].querySelector<HTMLElement>(".git-log-time")!;
          if (getComputedStyle(time).display !== "none") expect(time.getBoundingClientRect().right).to.be.at.most(row.left);
        });
      });
    });
  });

  it("경로를 누르면 diff 모달이 뜨고 두 hunk 패치가 skip 머리말과 추가·삭제 행으로 선다", () => {
    group("staged").find(".git-change-path").contains("a.ts").click();
    cy.wait("@gitDiff").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.path).to.equal("a.ts");
      expect(request.staged).to.equal(true);
      expect(request.commit ?? null).to.equal(null);
    });
    // 오른쪽 열이 아니라 모달이다. 새 창 버튼이 같은 대상을 별도 창으로 연다.
    panel().find(".git-panel-main .skill-diff.git-diff").should("not.exist");
    diffModal().should("be.visible").and("contain", "a.ts").and("contain", "스테이지됨");
    diffModal().find(".skill-diff.git-diff .skip").should("have.length", 2);
    diffModal().find(".skill-diff.git-diff .add").should("have.length", 2);
    diffModal().find(".skill-diff.git-diff .remove").should("have.length", 1);
    diffModal().find(".skill-diff.git-diff .meta").should("have.length", 4);
    diffModal().find(".modal-footer button").contains("전체 보기").click();
    diffModal().should("have.class", "full");
    diffModal().find(".modal-footer button").contains("기본 보기").click();
    diffModal().should("have.class", "wide").and("not.have.class", "full");
    diffModal().find(".modal-footer button").contains("새 창").should("exist");
    group("staged").find(".git-change-row.selected").should("contain", "a.ts");
    diffModal().find(".modal-footer button").contains("닫기").click();
    diffModal().should("not.exist");
    group("staged").find(".git-change-row.selected").should("not.exist");
  });

  it("작업 트리 diff의 전체 보기는 상태를 다시 읽어 내용이 바뀌면 전체 문맥도 다시 읽는다", () => {
    let revision = 1;
    cy.stubInvoke("get_project_git_diff", (req) => {
      const request = (req.body as { request?: { fullContext?: boolean } }).request;
      const tag = request?.fullContext ? "전체" : "기본";
      req.reply(gitDiff({ path: "b.ts", staged: false, patch: `diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-old\n+${tag} 판 ${revision}\n` }));
    }).as("liveDiff");
    group("unstaged").find(".git-change-path").contains("b.ts").click();
    diffModal().should("contain", "기본 판 1");
    diffModal().find(".modal-footer button").contains("전체 보기").click();
    diffModal().should("contain", "전체 판 1");
    // 다음 상태 폴링이 바뀐 기본 diff를 가져오면 전체 보기도 그 판으로 따라간다.
    cy.then(() => { revision = 2; });
    cy.get(".modal:has(.git-diff-modal-body)", { timeout: 25000 }).should("contain", "전체 판 2");
  });

  it("C16-7 병합 이력은 색이 다른 레인과 합류선으로 보인다", () => {
    stubGitReads({
      log: gitLog([
        gitCommit("4444444", "브랜치 병합", { parents: [fullSha("3333333"), fullSha("2222222")] }),
        gitCommit("3333333", "메인 작업", { parents: [fullSha("1111111")] }),
        gitCommit("2222222", "기능 브랜치 작업", { parents: [fullSha("1111111")], refs: ["feature/graph"] }),
        gitCommit("1111111", "공통 부모", { parents: [] }),
      ], false),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitLog");

    panel().find(".git-log-row").should("have.length", 4);
    panel().find(".git-log-graph").should("have.length", 4);
    panel().find(".git-log-row").eq(2).should("have.class", "lane-color-1");
    panel().find(".git-log-row").eq(2).find(".git-log-node").should("have.css", "left", "21px");
    panel().find(".git-log-row").eq(2).find(".git-graph-stroke").should("have.length.at.least", 2);
    panel().find(".git-log-row").eq(2).find(".git-log-refs .skill-extra-pill").should("contain", "feature/graph");

    cy.stubInvoke("get_project_git_commit_files", gitCommitFiles("2222222", [
      { path: "src/one.ts", originalPath: null, status: "modified" },
      { path: "src/two.ts", originalPath: null, status: "modified" },
    ])).as("graphCommitFiles");
    panel().find(".git-log-row").eq(2).find(".git-log-toggle").click();
    cy.wait("@graphCommitFiles");
    panel().find(".git-log-row").eq(2).find(".git-log-expanded .git-graph-tail").should("have.length", 1);
    panel().find(".git-log-row").eq(2).find(".git-log-expanded").then(($expanded) => {
      panel().find(".git-log-row").eq(2).find(".git-graph-tail").should(($tail) => {
        expect($tail[0].getBoundingClientRect().height).to.equal($expanded[0].getBoundingClientRect().height);
      });
    });
  });

  it("좁은 화면에서는 브랜치 묶음 다음에 이력이 시작해 서로 겹치지 않는다", () => {
    cy.viewport(500, 900);
    panel().find(".git-panel").should("have.css", "display", "flex");
    panel().find(".git-panel-aside").then(($aside) => {
      const asideBottom = $aside[0].getBoundingClientRect().bottom;
      panel().find(".git-panel-main").then(($main) => {
        expect($main[0].getBoundingClientRect().top, "이력 시작 위치").to.be.at.least(asideBottom);
      });
    });
  });

  it("브랜치 우클릭 메뉴에서 전환과 현재 브랜치 리베이스를 고를 수 있다", () => {
    cy.stubInvoke("rebase_project_git", gitReceipt({ action: "rebase" })).as("branchMenuRebase");
    panel().find(".git-branch-row").contains("feature").closest(".git-branch-row").rightclick();
    cy.get(".git-branch-context-menu").should("be.visible").and("contain", "feature");
    cy.get(".git-branch-context-menu button").contains("이 브랜치로 전환").should("not.be.disabled");
    cy.get(".git-branch-context-menu button").contains("이 브랜치 위로 옮기기").click();
    dialog().should("be.visible").and("contain", "main").and("contain", "feature");
    cy.get(".modal .button.primary").contains("시작").click();
    cy.wait("@branchMenuRebase").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.action).to.equal("start");
      expect(request.onto).to.equal("feature");
    });
  });

  it("브랜치 폴더를 단계별로 펼치고 목록 위의 일괄 펴기·접기를 사용한다", () => {
    stubGitReads({
      log: twoPageLog,
      overview: gitOverview({
        repository: gitRepository({
          localBranches: [
            gitBranch("main", { isHead: true, upstream: "origin/main" }),
            gitBranch("feature/mobile/login"),
            gitBranch("feature/mobile/logout"),
          ],
        }),
      }),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitOverview");

    panel().find(".git-branch-folder-toggle strong").should("contain", "feature").and("not.contain", "feature/mobile");
    panel().find(".git-branch-fold-all")
      .should("have.attr", "aria-label", "모든 브랜치 폴더 펴기")
      .and("contain", "전체 펴기");
    panel().find(".git-branch-fold-all").click();
    panel().find(".git-branch-folder-toggle strong").then(($labels) => {
      expect([...$labels].map((label) => label.textContent)).to.include.members(["feature", "mobile"]);
    });
    panel().find(".git-branch-row").should("contain", "login").and("contain", "logout");
    panel().find(".git-branch-fold-all").should("have.attr", "aria-label", "모든 브랜치 폴더 접기");
  });

  it("현재 브랜치 우클릭 메뉴에서 FF-only Pull을 실행한다", () => {
    cy.stubInvoke("pull_project_git", gitReceipt({ action: "pull" })).as("branchMenuPull");
    cy.stubInvoke("reapply_project_overlays", {
      schemaVersion: 1,
      repositoryId: "repo-alpha",
      repositoryRoot: "/tmp/amproj/alpha",
      head: fullSha("aaaaaaa"),
      trigger: "app",
      receipts: [],
      applied: 0,
      needsResolution: 0,
      busy: 0,
      failed: [],
      recovery: false,
      unreadable: [],
    }).as("overlayReapplyAfterPull");

    panel().find(".git-branch-row.current").rightclick();
    cy.get(".git-branch-context-menu").should("contain", "현재 브랜치");
    cy.get(".git-branch-context-menu button").contains("받아서 합치기 · 빨리감기만").should("not.be.disabled").click();
    cy.wait("@branchMenuPull").its("request.body.request").should("deep.include", {
      projectPath: "/tmp/amproj/alpha",
      mode: "ffOnly",
    });
    cy.wait("@overlayReapplyAfterPull");
  });

  it("diff 전체 보기에서는 바깥 본문 하나만 스크롤한다", () => {
    stubGitReads({ log: twoPageLog, diff: gitDiff({ patch: LONG_DIFF }) });
    cy.viewport(700, 400);
    group("staged").find(".git-change-path").contains("a.ts").click();
    cy.wait("@gitDiff");
    diffModal().find(".modal-footer button").contains("전체 보기").click();
    cy.get(".modal.full .modal-body").should(($body) => {
      expect($body.css("overflow-y")).to.equal("auto");
      expect($body[0].scrollHeight).to.be.greaterThan($body[0].clientHeight);
    }).scrollTo("bottom").should(($body) => {
      expect($body[0].scrollTop).to.be.greaterThan(0);
    });
    cy.get(".modal.full .git-diff-modal-body").should("have.css", "overflow-y", "visible");
    cy.get(".modal.full .skill-diff.git-diff").should("have.css", "overflow-y", "visible");
  });

  it("이력 행을 누르면 바꾼 파일이 펼쳐지고, 파일을 누르면 그 커밋의 diff 모달이 뜬다", () => {
    stubGitReads({
      log: gitLog([
        gitCommit("aaaaaaa", "로그인 오류를 바로잡는다", {
          body: "재현 조건을 기록하고\n토큰 만료 처리를 보강했습니다.",
          authorName: "reviewer",
          authorEmail: "reviewer@example.invalid",
          committerName: "release-bot",
        }),
        gitCommit("bbbbbbb", "문서 수정"),
      ], false),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitLog");
    panel().find(".git-log-search input").type("reviewer@example.invalid");
    panel().find(".git-log-row").should("have.length", 1).and("contain", "로그인 오류를 바로잡는다");
    panel().find(".git-log-toolbar").should("contain", "불러온 2개 중 1개");
    cy.stubInvoke("get_project_git_commit_files", gitCommitFiles("aaaaaaa", [
      { path: "src/new.ts", originalPath: "src/old.ts", status: "renamed" },
      { path: "README.md", originalPath: null, status: "modified" },
    ])).as("commitFiles");
    panel().find(".git-log-row").first().find(".git-log-toggle").click();
    cy.wait("@commitFiles").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.sha).to.equal(`aaaaaaa${"0".repeat(33)}`);
    });
    panel().find(".git-log-row.expanded .git-commit-detail")
      .should("contain", "로그인 오류를 바로잡는다")
      .and("contain", "재현 조건을 기록하고")
      .and("contain", "reviewer@example.invalid")
      .and("contain", "release-bot");
    panel().find(".git-log-row.expanded .git-commit-file").should("have.length", 2);
    // 2026-10-04: 비교 칸(B8)도 같은 `.git-commit-file`을 그리므로 이력 단언은 그 행 안으로
    // 좁힌다. 좁히지 않으면 위쪽 비교의 파일을 집어 이력이 아닌 것을 이력이라 주장한다.
    panel().find(".git-log-row.expanded .git-commit-file").first().should("contain", "src/old.ts").and("contain", "src/new.ts");
    cy.stubInvoke("get_project_git_diff", (req) => {
      const request = (req.body as { request?: { fullContext?: boolean } }).request;
      req.reply(gitDiff({ path: "README.md", staged: false, patch: request?.fullContext ? FULL_FILE_DIFF : LONG_DIFF }));
    }).as("commitDiff");
    panel().find(".git-log-row.expanded .git-commit-file .git-change-path").contains("README.md").click();
    cy.wait("@commitDiff").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.path).to.equal("README.md");
      expect(request.commit).to.equal(`aaaaaaa${"0".repeat(33)}`);
      expect(request.staged).to.equal(false);
      expect(request.fullContext ?? false).to.equal(false);
    });
    diffModal().should("be.visible").and("contain", "README.md").and("contain", "커밋 aaaaaaa");
    diffModal().find(".skill-diff.git-diff").should("exist");
    diffModal().find(".modal-footer button").contains("전체 보기").click();
    cy.wait("@commitDiff").its("request.body.request").should("include", { fullContext: true });
    diffModal().should("have.class", "full").and("contain", "파일 첫 줄 — 전체 보기에서만 보임").and("contain", "파일 마지막 줄 — 전체 보기에서만 보임");
    diffModal().find(".skill-diff.git-diff .remove").should("contain", "바꾸기 전");
    diffModal().find(".skill-diff.git-diff .add").should("contain", "바꾼 뒤");
    // 커밋 diff가 열린 동안 변경 목록 행은 강조되지 않는다.
    group("staged").find(".git-change-row.selected").should("not.exist");
    // 다시 누르면 접힌다.
    diffModal().find(".modal-footer button").contains("닫기").click();
    panel().find(".git-log-row").first().find(".git-log-toggle").click();
    panel().find(".git-log-row.expanded").should("not.exist");
  });

  it("밀어올리기는 앱 확인창을 거쳐 push_project_git을 보낸다", () => {
    cy.stubInvoke("push_project_git", gitReceipt({ action: "push", message: "밀어올렸습니다." })).as("push");
    overviewButton("올리기").click();
    dialog().should("be.visible").and("contain", "main").and("contain", "origin/main");
    cy.get(".modal .button.primary").contains("올리기").click();
    cy.wait("@push").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.remote).to.equal("origin");
      expect(request.setUpstream).to.equal(false);
    });
    panel().find(".git-receipt.succeeded").should("contain", "밀어올렸습니다.");
  });

  it("C16-11 인증 수단이 없는 HTTPS 원격이면 밀어올리기를 막고 연결 자리를 알린다", () => {
    cy.stubInvoke("push_project_git", gitReceipt({ action: "push" })).as("push");
    stubGitReads({
      log: twoPageLog,
      overview: gitOverview({
        repository: gitRepository({
          remotes: [{ name: "origin", url: "https://github.com/o/alpha.git", auth: { transport: "https", host: "github.com", method: "none", tokenSecret: null } }],
        }),
      }),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitOverview");
    overviewButton("올리기").should("be.disabled");
    overviewButton("원격 확인").should("not.be.disabled");
    overviewButton("받아서 합치기").should("not.be.disabled");
    panel().find(".git-remote-auth").should("contain", "github.com").and("contain", "톱니바퀴");
    cy.get("@push.all").should("have.length", 0);
  });

  it("C16-11 토큰이 지정된 원격이면 안내 없이 밀어올리기가 열린다", () => {
    stubGitReads({
      log: twoPageLog,
      overview: gitOverview({
        repository: gitRepository({
          remotes: [{ name: "origin", url: "https://github.com/o/alpha.git", auth: { transport: "https", host: "github.com", method: "token", tokenSecret: "GITHUB_TOKEN" } }],
        }),
      }),
    });
    overviewButton("새로고침").click();
    cy.wait("@gitOverview");
    overviewButton("올리기").should("not.be.disabled");
    panel().find(".git-remote-auth").should("not.exist");
  });

  it("스태시 버리기는 위험 확인창을 열고 취소하면 아무 명령도 보내지 않는다", () => {
    cy.stubInvoke("stash_project_git", gitReceipt({ action: "stash" })).as("stash");
    panel().find(".git-stash-row button").contains("버리기").click();
    dialog().should("be.visible").and("contain", "stash@{0}");
    cy.get(".modal .button.danger").should("exist");
    cy.get(".modal .button").contains("취소").click();
    dialog().should("not.exist");
    cy.get("@stash.all").should("have.length", 0);
  });

  it("리베이스 충돌 영수증은 충돌 파일을 나열하고, 진행 중이면 계속·건너뛰기·중단이 선다", () => {
    cy.stubInvoke("rebase_project_git", gitReceipt({
      action: "rebase",
      succeeded: false,
      outcome: "conflict",
      message: "충돌",
      conflictedFiles: ["d.ts"],
      stderr: "CONFLICT (content): Merge conflict in d.ts",
    })).as("rebase");
    overviewButton("브랜치 위로 옮기기…").click();
    panel().find(".git-rebase-form select").select("feature");
    // 확인이 통과한 뒤에 오는 개요는 리베이스 진행 중이다.
    panel().find(".git-rebase-form button").contains("시작").click();
    dialog().should("be.visible").and("contain", "feature");
    stubGitReads({
      overview: gitOverview({ repository: gitRepository({ inProgress: { kind: "rebase", headName: "main", onto: "feature", step: 1, total: 3 } }) }),
      log: twoPageLog,
    });
    cy.get(".modal .button.primary").contains("시작").click();
    cy.wait("@rebase").its("request.body").then((body) => {
      const request = JSON.parse(JSON.stringify(body)).request;
      expect(request.action).to.equal("start");
      expect(request.onto).to.equal("feature");
    });
    panel().find(".git-receipt.failed").should("contain", "충돌").and("contain", "conflict");
    panel().find(".git-conflict-list li").should("have.length", 1).and("contain", "d.ts");
    panel().find(".git-inprogress").should("contain", "1/3");
    panel().find(".git-inprogress-actions button").contains("계속").should("exist");
    panel().find(".git-inprogress-actions button").contains("AIA로 분석").should("exist");
    panel().find(".git-inprogress-actions button").contains("건너뛰기").should("exist");
    panel().find(".git-inprogress-actions button").contains("중단").should("exist");

    // 중단은 위험 확인창을 거친다.
    panel().find(".git-inprogress-actions button").contains("중단").click();
    dialog().should("be.visible");
    cy.get(".modal .button.danger").contains("중단").should("exist");
    cy.get(".modal .button").contains("취소").click();
  });
});
