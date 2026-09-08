/// <reference types="cypress" />
// QA #45 회귀: 설치본 차이 비교 패널(src/components/SkillInstallDiff.tsx)에서 내용은 같고
// 실행 권한만 다른 파일은 "… N줄 동일"만 든 빈 diff 대신 안내 한 줄을 받는다. 여러 줄이
// 같아 collapseUnchanged가 skip 행을 만들어도 마찬가지이고, 실행 권한 표시가 없는데
// 내용까지 같은 파일은 별도의 "차이 없음" 안내로 갈린다. 실제 줄 차이가 있는 파일은
// 여전히 본문을 싣는다.
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/qa45");

const install = {
  scope: "personal",
  projectPath: null,
  projectName: null,
  skillId: "alpha-claude",
  directory: "/tmp/qa45/claude/alpha-claude",
  contentDigest: "d2",
  divergent: true,
  readOnly: false,
};

const LIBRARY = library([
  entry("alpha", {
    common: true,
    providers: [providerState("claude", { skillId: "alpha-claude", installs: [install] })],
  }),
]);

const file = (path: string, overrides: Record<string, unknown> = {}) => ({
  path,
  status: "modified",
  executableChanged: false,
  binary: false,
  tooLarge: false,
  source: null,
  install: null,
  ...overrides,
});

const SAME_TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

const diffPanel = () => cy.get('[data-testid="skill-install-diff"]');
const fileRow = (path: string) => diffPanel().contains(".skill-diff-file", path);

describe("QA #45 실행 권한만 다른 파일의 설치본 차이 안내", () => {
  it("실행 권한만 다른 파일은 빈 diff 대신 안내를 내고, 줄 차이가 있는 파일은 본문을 싣는다", () => {
    cy.stubInvoke("get_skill_library", LIBRARY);
    cy.stubInvoke("compare_skill_install", {
      statusCode: 200,
      body: {
        key: "alpha",
        skillId: "alpha-claude",
        provider: "claude",
        directory: "/tmp/qa45/claude/alpha-claude",
        sourceDirectory: "/tmp/qa45/common/alpha",
        unchangedCount: 0,
        symlinks: [],
        truncated: false,
        files: [
          file("run.sh", { executableChanged: true, source: SAME_TEN_LINES, install: SAME_TEN_LINES }),
          file("same.txt", { source: "같은 줄\n", install: "같은 줄\n" }),
          file("SKILL.md", { source: "가\n나\n", install: "가\n다\n" }),
        ],
      },
    });
    openSkillLibrary();
    cy.get(".skill-library-row").contains("alpha").click();
    cy.get(".drawer").contains(".detail-card", "외부 수정 감지").contains("button", "변경 내용 보기").click();

    // 1) 첫 파일(run.sh)은 저절로 펼쳐진다. 열 줄이 모두 같아 접힘 행이 생길 상황이지만
    //    본문 대신 실행 권한 안내만 뜬다.
    fileRow("run.sh").should("have.attr", "aria-expanded", "true");
    fileRow("run.sh").find(".skill-diff-status").should("have.text", "수정 · 실행 권한");
    diffPanel().contains(".skill-diff-note", "내용은 같고 실행 권한만 다릅니다.").should("exist");
    diffPanel().find("pre.skill-diff").should("not.exist");
    diffPanel().find(".skip").should("not.exist");

    // 2) 실행 권한 표시가 없는데 내용도 같은 파일은 '차이 없음' 안내로 갈린다.
    fileRow("same.txt").click();
    diffPanel().contains(".skill-diff-note", "이 파일은 내용 차이가 없습니다.").should("exist");
    diffPanel().contains(".skill-diff-note", "내용은 같고 실행 권한만 다릅니다.").should("not.exist");
    diffPanel().find("pre.skill-diff").should("not.exist");

    // 3) 줄이 실제로 다른 파일은 여전히 본문을 싣는다.
    fileRow("SKILL.md").click();
    diffPanel().find("pre.skill-diff").should("have.length", 1);
    diffPanel().find("pre.skill-diff .remove .txt").should("contain.text", "나");
    diffPanel().find("pre.skill-diff .add .txt").should("contain.text", "다");
    diffPanel().find(".skill-diff-note").should("not.exist");
  });
});
