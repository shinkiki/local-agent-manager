/// <reference types="cypress" />
// 보관 스킬 드로어의 "외부 수정 감지" 절과 그 안의 파일별 차이 패널
// (src/components/SkillInstallDiff.tsx). 변경 내용 보기 토글이 compare_skill_install을
// 부르고, 요약 개수가 파일 상태별 집계와 맞고, 첫 파일이 저절로 펼쳐지고, 본문을 실을
// 수 없는 파일(바이너리·너무 큼)과 실행 권한만 다른 파일이 각자의 안내로 갈라지는지,
// 심볼릭 링크·잘림 안내와 비교 실패 오류가 뜨는지.
//
// 기존 스킬 스펙 일곱(AM-29·AM-40 필터, 일괄 작업 바 둘, 휴지통, 모드 탭, 번역 버튼)은
// 목록·필터·드로어 머리만 봤다. 설치본 차이 비교 패널은 아직 어느 시나리오도 열어 본
// 적이 없다.
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/am-skill-diff");

const install = (skillId: string) => ({
  scope: "personal",
  projectPath: null,
  projectName: null,
  skillId,
  directory: `/tmp/am-skill-diff/claude/${skillId}`,
  contentDigest: "d2",
  divergent: true,
  readOnly: false,
});

// alpha만 벌어진 설치본을 물고 있다. beta는 divergent가 아니라 절 자체가 없어야 한다.
const LIBRARY = library([
  entry("alpha", {
    common: true,
    providers: [providerState("claude", { skillId: "alpha-claude", installs: [install("alpha-claude")] })],
  }),
  entry("beta", {
    common: true,
    providers: [providerState("claude", { skillId: "beta-claude", installs: [{ ...install("beta-claude"), divergent: false }] })],
  }),
]);

const comparison = (overrides: Record<string, unknown> = {}) => ({
  key: "alpha",
  skillId: "alpha-claude",
  provider: "claude",
  directory: "/tmp/am-skill-diff/claude/alpha-claude",
  sourceDirectory: "/tmp/am-skill-diff/common/alpha",
  files: [],
  unchangedCount: 0,
  symlinks: [],
  truncated: false,
  ...overrides,
});

const file = (path: string, status: string, overrides: Record<string, unknown> = {}) => ({
  path,
  status,
  executableChanged: false,
  binary: false,
  tooLarge: false,
  source: null,
  install: null,
  ...overrides,
});

function openDrawer(name: string) {
  cy.stubInvoke("get_skill_library", LIBRARY);
  openSkillLibrary();
  cy.get(".skill-library-row").contains(name).click();
  return cy.get(".drawer").should("be.visible");
}

const divergentSection = () => cy.get(".drawer").contains(".detail-card", "외부 수정 감지");
const showChanges = () => divergentSection().contains("button", "변경 내용 보기");
const diffPanel = () => cy.get('[data-testid="skill-install-diff"]');

describe("보관 스킬 드로어의 설치본 차이 비교 패널", () => {
  it("변경 내용 보기가 비교를 불러 요약·파일 목록·첫 파일 본문을 낸다", () => {
    cy.stubInvoke("compare_skill_install", {
      statusCode: 200,
      body: comparison({
        unchangedCount: 3,
        files: [
          file("SKILL.md", "modified", { source: "가\n나\n", install: "가\n다\n" }),
          file("scripts/run.sh", "added", { install: "echo hi\n" }),
          file("old.txt", "removed", { source: "지운 줄\n" }),
        ],
      }),
    }).as("compare");
    openDrawer("alpha");

    // 1) 절이 열려 있어도 패널은 버튼을 누를 때까지 비교를 부르지 않는다.
    diffPanel().should("not.exist");
    showChanges().should("have.attr", "aria-expanded", "false");

    // 2) 누르면 비교 요청이 나가고 버튼 라벨이 닫기로 바뀐다.
    showChanges().click();
    cy.wait("@compare").its("request.body.request.skillId").should("eq", "alpha-claude");
    divergentSection().contains("button", "변경 내용 닫기").should("have.attr", "aria-expanded", "true");

    // 3) 요약은 방향 문구와 상태별 집계, 그리고 동일 건수를 함께 싣는다.
    diffPanel().find(".skill-diff-summary").within(() => {
      cy.contains("보관 원본 → 이 설치본").should("exist");
      cy.contains("추가 1").should("exist");
      cy.contains("삭제 1").should("exist");
      cy.contains("수정 1").should("exist");
      cy.contains("동일 3").should("exist");
    });

    // 4) 파일 세 줄이 각자 상태 딱지를 달고 나온다.
    diffPanel().find(".skill-diff-files > li").should("have.length", 3);
    diffPanel().contains(".skill-diff-file", "SKILL.md").find(".skill-diff-status.modified").should("have.text", "수정");
    diffPanel().contains(".skill-diff-file", "scripts/run.sh").find(".skill-diff-status.added").should("have.text", "추가");
    diffPanel().contains(".skill-diff-file", "old.txt").find(".skill-diff-status.removed").should("have.text", "삭제");

    // 5) 첫 파일만 저절로 펼쳐져 본문이 실린다.
    diffPanel().contains(".skill-diff-file", "SKILL.md").should("have.attr", "aria-expanded", "true");
    diffPanel().contains(".skill-diff-file", "old.txt").should("have.attr", "aria-expanded", "false");
    diffPanel().find("pre.skill-diff").should("have.length", 1);
    diffPanel().find("pre.skill-diff .remove .txt").should("contain.text", "나");
    diffPanel().find("pre.skill-diff .add .txt").should("contain.text", "다");

    // 6) 첫 파일을 다시 누르면 접히고, 다른 파일을 누르면 그 파일만 펼쳐진다.
    diffPanel().contains(".skill-diff-file", "SKILL.md").click();
    diffPanel().find("pre.skill-diff").should("not.exist");
    diffPanel().contains(".skill-diff-file", "old.txt").click();
    diffPanel().find("pre.skill-diff").should("have.length", 1);
    diffPanel().find("pre.skill-diff .remove .txt").should("contain.text", "지운 줄");

    // 7) 닫기를 누르면 패널이 사라진다.
    divergentSection().contains("button", "변경 내용 닫기").click();
    diffPanel().should("not.exist");
  });

  it("본문을 실을 수 없는 파일과 실행 권한만 다른 파일이 각자의 안내로 갈라진다", () => {
    cy.stubInvoke("compare_skill_install", {
      statusCode: 200,
      body: comparison({
        files: [
          file("logo.png", "modified", { binary: true }),
          file("huge.md", "modified", { tooLarge: true }),
          file("run.sh", "modified", { executableChanged: true, source: "같은 줄\n", install: "같은 줄\n" }),
        ],
      }),
    });
    openDrawer("alpha");
    showChanges().click();

    // 8) 바이너리는 첫 파일이라 펼쳐진 채 비교 불가 안내를 낸다. 요약 줄에는 '바이너리'.
    diffPanel().contains(".skill-diff-file", "logo.png").find("small").should("have.text", "바이너리");
    diffPanel().contains(".skill-diff-note", "텍스트가 아니어서 내용을 비교할 수 없습니다.").should("exist");

    // 9) 너무 큰 파일은 따로 안내한다.
    diffPanel().contains(".skill-diff-file", "huge.md").click();
    diffPanel().contains(".skill-diff-file", "huge.md").find("small").should("have.text", "너무 큼");
    diffPanel().contains(".skill-diff-note", "파일이 너무 커서 내용을 싣지 않았습니다.").should("exist");

    // 10) 내용은 같고 실행 권한만 다르면 상태 딱지에 사유가 붙는다.
    diffPanel().contains(".skill-diff-file", "run.sh").click();
    diffPanel().contains(".skill-diff-file", "run.sh").find(".skill-diff-status").should("have.text", "수정 · 실행 권한");

    // 11) 본문 대신 "내용은 같고 실행 권한만 다릅니다." 안내가 온다(QA #45). 차이 유무는
    // 접힌 rows 개수가 아니라 추가·삭제 줄 수로 판단하므로 "… 1줄 동일"만 든 빈 diff는 없다.
    diffPanel().contains(".skill-diff-note", "내용은 같고 실행 권한만 다릅니다.").should("exist");
    diffPanel().find("pre.skill-diff").should("not.exist");
  });

  it("심볼릭 링크·잘림·차이 없음·비교 실패가 각각 안내된다", () => {
    cy.stubInvoke("compare_skill_install", {
      statusCode: 200,
      body: comparison({ unchangedCount: 2, symlinks: ["link-a", "link-b"], truncated: true }),
    });
    openDrawer("alpha");
    showChanges().click();

    // 12) 링크는 개수와 함께 동기화 거절 사유까지 안내한다.
    diffPanel().contains(".skill-diff-note", "설치본의 심볼릭 링크 2개는 비교에서 제외했습니다.").should("exist");

    // 13) 상한을 넘겨 일부만 비교한 사실도 안내한다.
    diffPanel().contains(".skill-diff-note", "설치본 파일이 너무 많아 일부만 비교했습니다.").should("exist");

    // 14) 바뀐 파일이 없으면 목록 대신 지문만 다른 경우라는 안내가 온다.
    diffPanel().find(".skill-diff-files").should("not.exist");
    diffPanel().contains(".skill-diff-note", "내용 차이가 없습니다.").should("exist");
  });

  it("비교가 실패하면 패널 자리에 오류 배너가 뜬다", () => {
    cy.stubInvoke("compare_skill_install", { statusCode: 500, body: { error: "설치본을 읽지 못했습니다." } });
    openDrawer("alpha");
    showChanges().click();

    // 15) 오류면 요약·목록 대신 배너만 남는다.
    divergentSection().find(".error-banner").should("contain.text", "설치본을 읽지 못했습니다.");
    diffPanel().should("not.exist");
  });

  it("벌어진 설치본이 없는 스킬은 외부 수정 감지 절이 아예 없다", () => {
    cy.stubInvoke("compare_skill_install").as("compare");
    openDrawer("beta");

    // 16) divergent가 없으면 절도, 비교 요청도 없다.
    cy.get(".drawer").contains("외부 수정 감지").should("not.exist");
    cy.wait(300);
    cy.get("@compare.all").should("have.length", 0);
  });
});
