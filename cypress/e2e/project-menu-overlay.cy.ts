/// <reference types="cypress" />
/**
 * 프로젝트 메뉴 고도화 회차(docs/project-menu/acceptance.json의 `V3`)의 화면 흐름 스펙.
 *
 * 탭 하나 안쪽은 이미 셋이 본다 — 내비와 탭 복원(am20260928-projects-view-navigation),
 * 파일 탭의 트리·뷰어와 선택 저장(am20260928-projects-view-files), 형상관리 탭의 명령 인자
 * (am20260928-projects-view-git). 여기서 보는 것은 **탭을 건너는 자리**다.
 *
 * 1) 선택 박스는 파일 탭과 형상관리 탭이 **나눠 쓰는 하나**다(`ProjectsView`의 `selectedPath`).
 *    파일 탭에서 고른 프로젝트로 형상관리 탭이 열려야 하는데, 탭마다 선택을 따로 들면 화면은
 *    베타를 가리키면서 알파의 git 상태를 그린다 — 그러고도 양쪽 탭 스펙은 다 통과한다.
 * 2) 설정 탭에서 프로젝트를 제외하면 그 결과가 **같은 화면의 선택 목록에 즉시** 반영된다.
 *    `onRegistryChanged` → `registryRevision` → 등록부 재조회의 고리가 끊기면, 제외한
 *    프로젝트가 선택 박스에 남아 있다가 열리지 않는 폴더를 읽는다.
 *    저장된 선택 경로가 제외 대상이면 `resolveSelectedProjectPath`가 첫 활성 프로젝트로
 *    떨어뜨린다 — 오류가 아니다.
 * 3) overlay 탭(4-Overlay 단계, `O11`)의 흐름. 2026-10-04 이전에는 이 자리가 "overlay는
 *    화면에 없다"는 부재 단언이었다 — C19가 AGENTS.md에 서기 전에는 앱이 사용자 저장소
 *    작업 트리를 바꾸는 조작을 내줄 수 없었기 때문이다. C19가 섰고 사용자가 화면을
 *    승인했으므로(2026-10-02 회차 결정) 이제 그 부재가 아니라 **흐름**을 고정한다.
 *    여기서 보는 것은 영수증이다. `apply_project_overlay`가 `overlayNeedsResolution`을
 *    돌려주면 그것은 오류가 아니라 "검사가 실패해 아무것도 적용하지 않았다"는 결말이므로
 *    (C19-3), 화면은 오류 배너가 아니라 충돌 경로를 실은 영수증을 그려야 한다. 이 구분이
 *    무너지면 사용자는 작업 트리가 반쯤 바뀌었다고 믿게 된다.
 * 4) 외부 Git 작업 뒤의 자리(4-Overlay 단계, `O12`). 터미널에서 브랜치를 옮기면 보관해 둔
 *    patch는 작업 트리에 들어가 있지 않은데 앱은 그 사실을 모른다. C19-3이 요구하는 것은
 *    감지까지이고 **자동 적용은 금지**다 — 사람이 터미널에서 무엇을 하던 중인지 앱은 모르고,
 *    그 한가운데 작업 트리를 바꾸면 되돌릴 기준점 자체가 흔들린다. 그래서 여기서 고정하는 것은
 *    두 가지다: 배너가 뜨는가, 그리고 **apply가 저절로 나가지 않는가.**
 * 5) 그 반대쪽 자리(4-Overlay 단계, `O13`). **앱이** 브랜치를 옮긴 직후에는 C19-3이 자동
 *    검사·적용을 허용한다 — 사용자가 누른 것이 그 조작이고 앱은 자기가 무엇을 했는지 안다.
 *    4)와 5)가 한 스펙에 같이 있어야 하는 이유가 여기 있다: 두 자리의 요구가 **정반대**라
 *    한쪽만 보면 "자동 적용 금지"를 앱 경로까지 넓히거나 그 반대로 외부 경로까지 자동으로
 *    적용하게 고쳐도 스펙이 통과한다.
 */
import type {
  DocumentEntryPage,
  ProjectOverlayDrift,
  ProjectOverlayReapply,
  ProjectOverlayReceipt,
  ProjectOverlaySet,
  ProjectOverlaySets,
  ProjectRegistryEntry,
} from "../../src/types";
import { projectEntry } from "../support/projectRegistryFixtures";
import { gitReceipt, stubGitReads } from "../support/gitFixtures";

const ALPHA = "/tmp/amproj/alpha";
const BETA = "/tmp/amproj/beta";
const SELECTED_PATH_KEY = "agent-manager.projects-selected-path.v1";

const EMPTY_PAGE: DocumentEntryPage = { entries: [], nextCursor: null, total: 0 };

function selector() {
  return cy.anchor("projects.selector").find("select");
}

/**
 * 등록부를 **바뀔 수 있는** 상태로 세운다. `set_project_active`는 갱신된 목록을 돌려주고,
 * 그 뒤 화면이 다시 읽는 `get_project_registry`도 같은 목록을 내야 한다 — 고정값으로 세우면
 * 재조회가 제외 전 목록을 돌려주어 2)의 고리가 끊겨도 스펙이 통과한다.
 */
function stubMutableRegistry(initial: ProjectRegistryEntry[]): void {
  const state = { entries: initial };
  cy.stubInvoke("get_project_registry", (req) => req.reply(state.entries)).as("registry");
  cy.stubInvoke("set_project_active", (req) => {
    const { request } = req.body as { request: { path: string; active: boolean } };
    state.entries = state.entries.map((entry) => (
      entry.path === request.path ? { ...entry, active: request.active, pending: false } : entry
    ));
    req.reply(state.entries);
  }).as("setActive");
}

/** 세트 하나. 화면이 읽는 것은 메타데이터뿐이고 patch 본문은 오지 않는다(C19-1). */
function overlaySet(name: string, paths: string[]): ProjectOverlaySet {
  return {
    schemaVersion: 1,
    setId: "set-1",
    name,
    repositoryId: "alpha",
    repositoryRoot: ALPHA,
    paths,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    baseHead: "0123456789abcdef0123456789abcdef01234567",
    snapshotId: null,
    patchDigest: null,
    state: "registered",
  };
}

/** 외부 Git 작업 감지 답(C19-3). 실리는 것은 patch가 보관된 세트뿐이다. */
function overlayDrift(entries: ProjectOverlayDrift["sets"]): ProjectOverlayDrift {
  return {
    schemaVersion: 1,
    repositoryId: "alpha",
    repositoryRoot: ALPHA,
    currentHead: "fedcba9876543210fedcba9876543210fedcba98",
    sets: entries,
    unreadable: [],
  };
}

/** 앱이 시작한 Git 작업 뒤의 일괄 재적용 답(C19-3). */
function overlayReapply(overrides: Partial<ProjectOverlayReapply> = {}): ProjectOverlayReapply {
  return {
    schemaVersion: 1,
    repositoryId: "alpha",
    repositoryRoot: ALPHA,
    head: "fedcba9876543210fedcba9876543210fedcba98",
    trigger: "app",
    receipts: [],
    applied: 0,
    needsResolution: 0,
    busy: 0,
    failed: [],
    recovery: false,
    unreadable: [],
    ...overrides,
  };
}

function overlayReceipt(overrides: Partial<ProjectOverlayReceipt> & Pick<ProjectOverlayReceipt, "action" | "outcome" | "message">): ProjectOverlayReceipt {
  return {
    succeeded: true,
    headBefore: "0123456789abcdef0123456789abcdef01234567",
    headAfter: "0123456789abcdef0123456789abcdef01234567",
    setId: "set-1",
    snapshotId: null,
    patchDigest: null,
    affected: [],
    rejected: [],
    trigger: "app",
    ...overrides,
  };
}

describe("프로젝트 메뉴 · 탭을 건너는 선택과 overlay 흐름", () => {
  beforeEach(() => {
    cy.visitApp();
    stubMutableRegistry([projectEntry("alpha"), projectEntry("beta")]);
    cy.stubInvoke("list_project_entries", EMPTY_PAGE).as("list");
    stubGitReads();
  });

  it("파일 탭에서 고른 프로젝트를 형상관리 탭이 그대로 이어받는다", () => {
    cy.openProjectsView("files");
    selector().should("have.value", ALPHA);
    // 뜨자마자 나간 알파 조회를 먼저 걷어내야 다음 `@list`가 베타 조회다.
    cy.wait("@list").its("request.body.request.projectPath").should("eq", ALPHA);

    selector().select(BETA);
    cy.wait("@list").its("request.body.request.projectPath").should("eq", BETA);

    // 탭을 옮겨도 같은 선택이고, 형상관리 조회도 그 경로로 나간다.
    cy.openProjectsTab("git");
    selector().should("have.value", BETA);
    cy.wait("@gitOverview").its("request.body.request.projectPath").should("eq", BETA);
    cy.wait("@gitStatus").its("request.body.request.projectPath").should("eq", BETA);

    // 돌아와도 선택은 그대로다 — 탭마다 따로 들지 않는다.
    cy.openProjectsTab("files");
    selector().should("have.value", BETA);
  });

  it("설정 탭에서 제외한 프로젝트는 선택 목록에서 사라지고 남은 활성으로 떨어진다", () => {
    cy.openProjectsView("files");
    cy.wait("@list");
    selector().select(BETA);
    cy.wait("@list");
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SELECTED_PATH_KEY), "고른 경로가 저장된다").to.eq(BETA);
    });

    cy.openProjectsTab("settings");
    cy.get(".project-registry-row").contains("strong", "beta").closest(".project-registry-row")
      .find('[role="switch"]').click();
    cy.wait("@setActive").its("request.body.request").should("deep.include", { path: BETA, active: false });

    // 제외 결과가 같은 화면의 선택 목록에 돌아온다. 저장값(beta)은 그대로지만 활성이 아니므로
    // 첫 활성 프로젝트로 떨어진다.
    cy.openProjectsTab("files");
    selector().find("option").should("have.length", 1);
    selector().should("have.value", ALPHA);
    cy.window().then((win) => {
      expect(win.localStorage.getItem(SELECTED_PATH_KEY), "떨어진 것이지 저장값을 지운 것이 아니다").to.eq(BETA);
    });
  });

  it("overlay 탭에서 세트를 저장하고 적용하면 영수증이 그대로 보인다", () => {
    cy.viewport(1440, 900);
    const sets: ProjectOverlaySets = { schemaVersion: 1, repositoryId: "alpha", repositoryRoot: ALPHA, sets: [], unreadable: [] };
    cy.stubInvoke("list_project_overlay_sets", (req) => req.reply(sets)).as("overlaySets");
    // 이 흐름에서는 앱이 시작한 조작만 있으므로 외부 이동은 없다.
    cy.stubInvoke("get_project_overlay_drift", overlayDrift([])).as("overlayDrift");
    cy.stubInvoke("save_project_overlay_set", (req) => {
      const { request } = req.body as { request: { name: string; paths: string[] } };
      sets.sets = [overlaySet(request.name, request.paths)];
      req.reply(overlayReceipt({ action: "save", outcome: "saved", message: "세트를 저장했습니다." }));
    }).as("overlaySave");
    // 스냅샷이 돌면 세트는 `stored`가 된다. patch가 없는 세트에 적용 버튼이 열려 있으면
    // 화면이 백엔드의 거절을 미리 막지 못한다 — 그 상태 전이를 여기서 같이 본다.
    cy.stubInvoke("snapshot_project_overlay", (req) => {
      sets.sets = sets.sets.map((set) => ({ ...set, state: "stored", snapshotId: "snap-1", patchDigest: "d".repeat(64) }));
      req.reply(overlayReceipt({ action: "snapshot", outcome: "snapshotted", message: "patch를 뜨고 작업 트리를 되돌렸습니다." }));
    }).as("overlaySnapshot");
    // 적용은 일부러 실패시킨다. 성공만 보는 스펙은 이 기능에서 제일 중요한 결말을 놓친다.
    cy.stubInvoke("apply_project_overlay", overlayReceipt({
      action: "apply",
      outcome: "overlayNeedsResolution",
      succeeded: false,
      message: "적용 검사가 실패했습니다.",
      affected: ["b.ts"],
    })).as("overlayApply");

    cy.openProjectsView("files");
    cy.view("projects").find('[role="tablist"] [role="tab"]').should("have.length", 4);
    cy.get('[data-ui-anchor="projects.tab.overlay"]').should("exist");

    cy.openProjectsTab("overlay");
    cy.wait("@overlaySets").its("request.body.request.projectPath").should("eq", ALPHA);

    // 2026-10-06 UI 회차. 생성 폼과 보관 목록이 페이지 양끝에 흩어졌던 화면을 한 작업대의
    // 두 카드로 묶었다. 넓은 화면에서 둘이 나란히 있어야 현재 변경과 저장 결과를 한 시야에서
    // 비교할 수 있고, 아래 선택 수는 저장 버튼이 비활성인 이유를 숫자로 설명한다.
    cy.view("projects").find(".overlay-workspace > .overlay-card").should("have.length", 2).then(($cards) => {
      const capture = $cards[0].getBoundingClientRect();
      const saved = $cards[1].getBoundingClientRect();
      expect(Math.abs(capture.top - saved.top), "두 단계가 같은 행에서 시작한다").to.be.lessThan(2);
      expect(capture.right, "생성 카드가 보관 카드 왼쪽에 있다").to.be.lessThan(saved.left);
    });
    cy.view("projects").find(".overlay-summary").should("contain.text", "담을 수 있는 변경").and("contain.text", "저장한 세트");

    // 후보는 추적 파일의 unstaged 변경뿐이다 — untracked(c.txt)와 충돌(d.ts)은 고를 수 없다.
    cy.view("projects").find(".overlay-candidates code").should("have.length", 1).and("have.text", "b.ts");

    cy.get('[data-ui-anchor="projects.overlay.name"]').type("로컬 디버그 플래그");
    cy.view("projects").find(".overlay-picker-actions button").contains("모두 선택").click();
    cy.view("projects").find(".overlay-create-actions").should("contain.text", "1개 선택");
    cy.get('[data-ui-anchor="projects.overlay.save"]').click();
    cy.wait("@overlaySave").its("request.body.request").should("deep.include", { projectPath: ALPHA, name: "로컬 디버그 플래그" });

    cy.view("projects").find(".overlay-set-row").should("have.length", 1);
    cy.view("projects").find('[data-overlay-state="registered"]').should("have.text", "스냅샷 전");
    // patch를 뜨기 전에는 적용도 적용 검사도 열리지 않는다.
    cy.view("projects").find('[data-overlay-action="apply"]').should("be.disabled");
    cy.view("projects").find('[data-overlay-action="snapshot"]').click();
    cy.wait("@overlaySnapshot").its("request.body.request").should("deep.include", { projectPath: ALPHA, setId: "set-1" });

    cy.view("projects").find('[data-overlay-action="apply"]').click();
    cy.wait("@overlayApply");
    // 실패가 아니라 영수증이다 — 오류 배너가 아니라 결말과 충돌 경로가 보인다.
    cy.view("projects").find('[data-overlay-outcome="overlayNeedsResolution"]').should("exist")
      .and("contain.text", "적용 검사가 실패했습니다.")
      .and("contain.text", "b.ts");
    cy.view("projects").find(".error-banner").should("not.exist");
  });

  it("외부에서 브랜치가 바뀌면 배너로 알리고 저절로 적용하지는 않는다", () => {
    const sets: ProjectOverlaySets = {
      schemaVersion: 1,
      repositoryId: "alpha",
      repositoryRoot: ALPHA,
      sets: [{
        ...overlaySet("로컬 포트", ["b.ts"]),
        state: "stored",
        snapshotId: "snap-1",
        patchDigest: "d".repeat(64),
      }],
      unreadable: [],
    };
    cy.stubInvoke("list_project_overlay_sets", sets).as("overlaySets");
    // 기준 HEAD와 지금 HEAD가 다르다 — 앱을 거치지 않은 Git 작업이 있었다는 뜻이다.
    cy.stubInvoke("get_project_overlay_drift", overlayDrift([{
      setId: "set-1",
      name: "로컬 포트",
      state: "stored",
      baseHead: "0123456789abcdef0123456789abcdef01234567",
      headMoved: true,
      trigger: "external",
    }])).as("overlayDrift");
    cy.stubInvoke("check_project_overlay_apply", overlayReceipt({
      action: "checkOverlayApply",
      outcome: "applicable",
      message: "지금 작업 트리에 다시 적용할 수 있습니다",
    })).as("overlayCheck");
    // 일부러 스텁해 두고 **호출되지 않는 것**을 단언한다. 스텁이 없으면 "안 불렸다"와
    // "부를 자리가 없었다"가 구별되지 않는다.
    cy.stubInvoke("apply_project_overlay", overlayReceipt({
      action: "applyOverlay",
      outcome: "applied",
      message: "적용했습니다",
    })).as("overlayApply");

    cy.openProjectsView("files");
    cy.openProjectsTab("overlay");
    cy.wait("@overlayDrift").its("request.body.request.projectPath").should("eq", ALPHA);

    cy.view("projects").find('[data-overlay-drift-banner="external"]').should("exist")
      .and("contain.text", "앱 밖에서 브랜치가 바뀌었습니다")
      .and("contain.text", "자동으로 적용하지 않습니다");
    cy.view("projects").find('[data-overlay-drift-set="set-1"]').should("contain.text", "로컬 포트");
    cy.view("projects").find('.overlay-set-row[data-overlay-drift="external"]').should("exist");

    // 배너가 내미는 것은 검사이지 적용이 아니다(C19-3).
    cy.view("projects").find('[data-overlay-action="drift-check"]').click();
    cy.wait("@overlayCheck").its("request.body.request").should("deep.include", { projectPath: ALPHA, setId: "set-1" });
    cy.view("projects").find('[data-overlay-outcome="applicable"]').should("exist");
    cy.get("@overlayApply.all").should("have.length", 0);
  });

  it("형상관리 탭에서 브랜치를 옮기면 보관한 overlay가 저절로 다시 들어간다", () => {
    cy.stubInvoke("switch_project_git_branch", gitReceipt({ action: "switch", message: "feature 로 전환했습니다." })).as("gitSwitch");
    cy.stubInvoke("reapply_project_overlays", overlayReapply({
      applied: 1,
      receipts: [overlayReceipt({ action: "applyOverlay", outcome: "applied", message: "적용했습니다" })],
    })).as("overlayReapply");
    // 적용은 일괄 재적용 **안에서** 일어난다. 화면이 세트마다 apply를 따로 쏘면 같은 patch가
    // 두 번 나가고 두 번째는 "이미 적용된 세트"로 거절된다 — 사용자가 한 적 없는 실패다.
    cy.stubInvoke("apply_project_overlay", overlayReceipt({ action: "applyOverlay", outcome: "applied", message: "적용했습니다" })).as("overlayApplyDirect");

    cy.openProjectsView("files");
    cy.openProjectsTab("git");
    cy.wait("@gitOverview");
    cy.view("projects").find(".git-branch-row").contains("strong", "feature")
      .closest(".git-branch-row").find("button").contains("전환").click();
    cy.wait("@gitSwitch").its("request.body.request").should("deep.include", { projectPath: ALPHA, branch: "feature" });

    // 재적용은 앱이 옮긴 **직후** 같은 프로젝트로 나간다. 세트 id는 싣지 않는다 — 무엇을
    // 다시 넣을지는 장부의 상태가 정한다(C19-3).
    cy.wait("@overlayReapply").its("request.body.request")
      .should("deep.equal", { projectPath: ALPHA, recovery: false });
    cy.get("@overlayApplyDirect.all").should("have.length", 0);

    cy.view("projects").find('[data-overlay-reapply="applied"]').should("exist")
      .and("contain.text", "다시 넣었습니다");
    cy.view("projects").find(".error-banner").should("not.exist");
  });
  // C19-3의 실행 규칙 7. 실패한 Git 작업 뒤는 성공한 뒤와 **같은 자리가 아니다** — HEAD가
  // 움직이지 않았으므로 "브랜치를 옮긴 뒤"라고 적으면 거짓이고, 재적용까지 실패하면 사용자는
  // 실패한 Git 영수증과 빠져 있는 로컬 변경을 동시에 떠안는다. 두 경우를 성공 경로와 같은
  // 스펙에 나란히 두는 이유는 요구가 정반대라 한쪽만 보면 반대쪽으로 고쳐도 통과하기 때문이다.
  it("브랜치 전환이 실패하면 복구로 되돌리고, 그 복구까지 실패하면 조용히 넘어가지 않는다", () => {
    cy.stubInvoke("switch_project_git_branch", {
      statusCode: 500,
      body: { error: "작업 트리에 충돌이 있어 전환하지 못했습니다" },
    }).as("gitSwitch");
    cy.stubInvoke("reapply_project_overlays", overlayReapply({
      applied: 1,
      recovery: true,
      receipts: [overlayReceipt({ action: "applyOverlay", outcome: "applied", message: "되돌렸습니다" })],
    })).as("overlayReapply");

    cy.openProjectsView("files");
    cy.openProjectsTab("git");
    cy.wait("@gitOverview");
    cy.view("projects").find(".git-branch-row").contains("strong", "feature")
      .closest(".git-branch-row").find("button").contains("전환").click();
    cy.wait("@gitSwitch");

    // 실패한 작업 뒤에도 재적용은 나가고, 복구였다는 사실이 요청에 실린다.
    cy.wait("@overlayReapply").its("request.body.request")
      .should("deep.equal", { projectPath: ALPHA, recovery: true });
    cy.view("projects").find('[data-overlay-recovery="true"]').should("exist")
      .and("contain.text", "이전 브랜치");

    // 이제 재적용 호출 자체가 실패하는 경우. 예전에는 이 자리가 조용히 null 이었다.
    cy.stubInvoke("reapply_project_overlays", {
      statusCode: 500,
      body: { error: "overlay 장부를 읽지 못했습니다" },
    }).as("overlayReapplyFailed");
    cy.view("projects").find(".git-branch-row").contains("strong", "feature")
      .closest(".git-branch-row").find("button").contains("전환").click();
    cy.wait("@overlayReapplyFailed");
    cy.view("projects").find('[data-overlay-reapply="failed"]').should("exist")
      .and("contain.text", "patch는 그대로 남아");
  });
});
