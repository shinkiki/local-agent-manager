/// <reference types="cypress" />
/**
 * 스킬 → 스킬관리(보관 스킬) 드로워의 **"사용 설정" 위치×공급자 표**
 * (SkillLibraryPanel.tsx:2076 `SkillLocationMatrixSection`).
 *
 * 2026-09-19 리팩토링 `d622dc93`이 이 표와 지침 배포 매트릭스가 각자 펼쳐 두던
 * `skill-location-matrix` 껍데기를 `LocationProviderMatrix`(SkillLibraryPanel.tsx:2145
 * 언저리) 한 벌로 모았다. 지침 쪽 표는 AM-136(am20260907-instruction-location-matrix)이
 * 보고 있지만, **스킬 쪽 표는 어느 스펙도 열어 본 적이 없다** — 보관 스킬 스펙 일곱
 * (AM-29·AM-40 필터, 일괄 작업 바 둘, 휴지통, 모드 탭, 설치본 차이)은 목록·툴바·다른
 * 절만 봤고, "사용 설정"이라는 이름이 붙은 am20260914-claude-skill-usage-override는
 * 스킬정보 화면의 Claude 재정의 카드라 이 표와 다른 자리다.
 *
 * 이 표가 조용히 갈라지면 사용자는 **엉뚱한 위치의 사용본을 켜거나 끈다.** 해제는 사용본을
 * 휴지통으로 옮기는 파괴적 동작이라, 행이 가리키는 위치와 실제로 나가는 요청의 위치가
 * 어긋나면 남의 프로젝트 사용본이 사라진다.
 *
 * 축은 스킬, 조건은 (1) 미지원 공급자가 열에서 빠지는 경계, (2) 개인·프로젝트 행이
 * 각자의 설치본만 읽는 위치 분리, (3) 확인 대화와 실제 요청 인자가 같은 위치를 가리키는가다.
 */
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const ROOT = "/tmp/am20260919-skill-use";
const PROJECT_A = `${ROOT}/proj-a`;
const PROJECT_B = `${ROOT}/proj-b`;

const { entry, providerState, library } = skillLibraryFixtures(ROOT);

const install = (
  skillId: string,
  scope: "personal" | "project",
  projectPath: string | null,
  projectName: string | null,
  divergent = false,
) => ({
  scope,
  projectPath,
  projectName,
  skillId,
  directory: projectPath ? `${projectPath}/.claude/skills/alpha` : `${ROOT}/claude/alpha`,
  contentDigest: "d1",
  divergent,
  readOnly: false,
});

/**
 * alpha 한 건.
 * - claude: 개인과 '프로젝트 가'에 사용본이 있고, '프로젝트 가' 쪽만 외부 수정으로 벌어졌다.
 * - codex: 지원하지만 사용본이 하나도 없다(`missing`).
 * - antigravity: 사용자 스킬 루트가 없어 `unsupported` — 표의 열에서 빠져야 한다.
 */
const ALPHA = entry("alpha", {
  common: true,
  providers: [
    providerState("claude", {
      skillId: "alpha-claude",
      installs: [
        install("alpha-claude", "personal", null, null),
        install("alpha-claude-a", "project", PROJECT_A, "프로젝트 가", true),
      ],
    }),
    providerState("codex", { status: "missing", skillId: null, installs: [] }),
    providerState("antigravity", { status: "unsupported", skillId: null, installs: [] }),
  ],
});

const LIBRARY = {
  ...library([ALPHA]),
  projects: [
    { path: PROJECT_A, name: "프로젝트 가" },
    { path: PROJECT_B, name: "프로젝트 나" },
  ],
};

const matrix = () => cy.get(".drawer").find("table.skill-location-matrix");
const headers = () => matrix().find("thead th");
const rows = () => matrix().find("tbody tr");
/** 행 이름과 열 순번으로 집는 칸 하나. 열 순번은 머리줄의 공급자 순서를 그대로 쓴다. */
const cellBox = (rowLabel: string, column: number) =>
  matrix().contains("tbody tr td", rowLabel).parent().find("td").eq(column).find("input[type=checkbox]");
const dialog = () => cy.get(".modal[role='dialog']");

function openDrawer(): void {
  cy.stubInvoke("get_skill_library", LIBRARY);
  openSkillLibrary();
  cy.get(".skill-library-row").contains("alpha").click();
  cy.get(".drawer").should("be.visible");
}

describe("보관 스킬 드로워의 사용 설정 위치×공급자 표", () => {
  it("열은 지원 공급자만 세우고 행은 개인과 등록 프로젝트를 모두 세운다", () => {
    openDrawer();

    // 1) 머리줄 첫 칸은 '위치', 나머지는 지원 공급자 이름표뿐이다.
    headers().should("have.length", 3);
    headers().eq(0).should("have.text", "위치");
    headers().eq(1).should("have.text", "Claude");
    headers().eq(2).should("have.text", "Codex");

    // 2) 미지원 공급자는 열 자체가 없다 — 켤 수 없는 칸을 내놓으면 안 된다.
    matrix().should("not.contain.text", "Antigravity");

    // 3) 행은 개인 + 등록 프로젝트 둘. 사용본이 없는 '프로젝트 나'도 자리를 얻는다.
    rows().should("have.length", 3);
    rows().eq(0).find("td").first().should("have.text", "개인");
    rows().eq(1).find("td").first().should("have.text", "프로젝트 가");
    rows().eq(2).find("td").first().should("have.text", "프로젝트 나");
  });

  it("칸의 체크는 그 위치의 사용본만 읽고 외부 수정은 그 칸에만 표시된다", () => {
    openDrawer();

    // 4) claude 열: 개인과 '프로젝트 가'만 켜져 있고 '프로젝트 나'는 꺼져 있다.
    cellBox("개인", 1).should("be.checked");
    cellBox("프로젝트 가", 1).should("be.checked");
    cellBox("프로젝트 나", 1).should("not.be.checked");

    // 5) codex 열은 사용본이 없어 세 칸 모두 꺼져 있다 — 공급자 사이가 새지 않는다.
    cellBox("개인", 2).should("not.be.checked");
    cellBox("프로젝트 가", 2).should("not.be.checked");
    cellBox("프로젝트 나", 2).should("not.be.checked");

    // 6) 외부 수정 표시는 벌어진 사용본이 있는 한 칸에만 붙는다.
    matrix().contains("tbody tr td", "프로젝트 가").parent()
      .find("td").eq(1).find("label.skill-use-toggle").should("have.class", "divergent");
    matrix().contains("tbody tr td", "개인").parent()
      .find("td").eq(1).find("label.skill-use-toggle").should("not.have.class", "divergent");
    matrix().find("label.skill-use-toggle.divergent").should("have.length", 1);

    cy.screenshot("am20260919-skill-use-location-matrix", { overwrite: true });
  });

  it("프로젝트 행을 켜면 확인 대화와 배포 요청이 같은 프로젝트를 가리킨다", () => {
    cy.stubInvoke("publish_common_skill", {
      statusCode: 200,
      body: {
        key: "alpha",
        sourceDigest: "d1",
        results: [{ provider: "codex", outcome: "published", directory: `${PROJECT_B}/.codex/skills/alpha`, message: null }],
        report: { key: "alpha", sourceDigest: "d1", fileCount: 1, totalBytes: 100, providers: [], issues: [] },
      },
    }).as("publish");
    openDrawer();

    // 7) 사용본이 없는 '프로젝트 나'의 codex 칸을 켠다.
    cellBox("프로젝트 나", 2).click();

    // 8) 확인 대화가 공급자와 위치를 함께 이름으로 적는다 — 경로만 적으면 고른 자리를 못 읽는다.
    dialog().should("contain.text", "Codex").and("contain.text", "프로젝트 나");
    dialog().contains("button", "사용").click();

    // 9) 요청은 고른 공급자 하나와 그 프로젝트 위치로 나간다.
    cy.wait("@publish").its("request.body.request").should((request: Record<string, unknown>) => {
      expect(request.key).to.equal("alpha");
      expect(request.providers).to.deep.equal(["codex"]);
      expect(request.location).to.deep.equal({ scope: "project", projectPath: PROJECT_B });
    });
  });

  it("개인 행을 끄면 그 위치의 사용본만 휴지통으로 가고 취소는 아무것도 보내지 않는다", () => {
    cy.stubInvoke("delete_skill", {
      statusCode: 200,
      body: { items: [], groupId: "g1" },
    }).as("deleteSkill");
    openDrawer();

    // 10) 취소하면 요청이 나가지 않는다 — 해제는 사용본을 옮기는 동작이라 되돌릴 자리가 없다.
    cellBox("개인", 1).click();
    dialog().should("contain.text", "사용 해제");
    dialog().contains("button", "취소").click();
    cy.get(".modal[role='dialog']").should("not.exist");
    cy.get("@deleteSkill.all").should("have.length", 0);

    // 11) 확인하면 개인 위치의 사용본 id로만 나간다 — '프로젝트 가' 사용본은 건드리지 않는다.
    cellBox("개인", 1).click();
    dialog().contains("button", "사용 해제").click();
    cy.wait("@deleteSkill").its("request.body.request.id").should("equal", "alpha-claude");
  });
});
