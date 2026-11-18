/**
 * 스킬 → 스킬정보 → 설치본 드로워의 **구성 파일 집계와 파일 트리**.
 *
 * 드로워 머리 표의 마지막 칸은 `countFiles(detail.files)`가 센다(SkillsView.tsx:352,
 * 502). 이 함수는 디렉터리 노드를 세지 않고 그 아래로 내려가 파일만 더하므로, 중첩이
 * 깊어져도 사람이 세는 "파일 개수"와 같아야 한다. 아래 파일 카드는 같은 트리를 depth마다
 * 14px씩 밀어 그린다(같은 파일 498줄).
 *
 * 기존 스킬 시나리오는 목록·필터·툴바(AM-9·AM-10·AM-40·AM-108), 드로워의 사용 설정
 * (am20260914-claude-skill-usage-override), 상세 조회 실패(am20260916-skill-detail-load-failure)
 * 까지만 봤고, **상세가 성공했을 때 그려지는 구성 파일 집계와 트리**를 확인한 스펙은 없다.
 * 노션 Test Scenario에도 "스킬 상세 드로워 구성 파일/파일 트리" 시나리오는 없다.
 *
 * 축은 스킬, 조건은 경계값(빈 목록·중첩 트리)과 다국어 전환이다.
 */
import type { FileNode, SkillSummary } from "../../src/types";

const SKILL_ROOT = "/tmp/am20260917-skills";

function skill(key: string, name: string): SkillSummary {
  return {
    id: `codex:personal:${key}`,
    source: "codex",
    scope: "personal",
    name,
    description: `${name} 설명`,
    path: `${SKILL_ROOT}/${key}/SKILL.md`,
    directory: `${SKILL_ROOT}/${key}`,
    origin: null,
    archived: false,
  };
}

function file(name: string, parent: string): FileNode {
  return { name, relativePath: `${parent}${name}`, sizeBytes: 12, isDirectory: false, children: [] };
}

function dir(name: string, parent: string, children: FileNode[]): FileNode {
  return { name, relativePath: `${parent}${name}`, sizeBytes: 0, isDirectory: true, children };
}

/**
 * 파일 4개 · 디렉터리 3개(그중 하나는 빈 디렉터리)로 3단 중첩을 만든다.
 * 집계는 디렉터리를 빼고 4가 나와야 한다.
 */
const NESTED: FileNode[] = [
  file("SKILL.md", ""),
  dir("references", "", [
    file("palette.md", "references/"),
    dir("deep", "references/", [file("nested.md", "references/deep/")]),
  ]),
  dir("empty", "", []),
  file("run.sh", ""),
];

const TREE = skill("tree", "트리스킬");
const BARE = skill("bare", "민짜스킬");
const SKILLS = [TREE, BARE];

const drawer = () => cy.get(".drawer");
const metaCells = () => drawer().find(".detail-card.meta-grid > div");
const fileRows = () => drawer().find(".detail-card").last().find(".file-row");

function stubDetail(): void {
  cy.stubInvoke("get_skill_detail", (req) => {
    const id = (req.body as { id: string }).id;
    const target = SKILLS.find((entry) => entry.id === id) ?? TREE;
    req.reply({
      statusCode: 200,
      body: {
        skill: target,
        body: `# ${target.name}\n\n${target.name} 본문입니다.`,
        files: target.id === TREE.id ? NESTED : [],
      },
    });
  }).as("detail");
}

function openSkills(): void {
  cy.stubSnapshotField("skills", SKILLS);
  cy.visitApp();
  cy.openView("skills");
  cy.get(".skill-library-list > .skill-library-item").should("have.length", 2);
}

function openDrawer(target: SkillSummary): void {
  cy.contains(".skill-library-row-head strong", target.name).click();
  drawer().should("exist");
  drawer().find(".detail-card.meta-grid").should("exist");
}

describe("설치 스킬 상세의 구성 파일 집계와 파일 트리", () => {
  it("중첩 트리에서 집계는 디렉터리를 빼고 파일만 세고, 트리는 깊이만큼 밀려 그려진다", () => {
    stubDetail();
    openSkills();
    openDrawer(TREE);

    // 1) 머리 표의 마지막 칸이 구성 파일 개수다. 디렉터리 3개는 세지 않으므로 4개다.
    metaCells().last().within(() => {
      cy.get("span").should("have.text", "구성 파일");
      cy.get("strong").should("have.text", "4개");
    });

    // 2) 트리는 디렉터리까지 모두 줄로 그린다 — 파일 4 + 디렉터리 3 = 7줄.
    fileRows().should("have.length", 7);
    fileRows().then(($rows) => {
      const names = [...$rows].map((row) => row.querySelector("code")?.textContent ?? "");
      expect(names).to.deep.equal([
        "SKILL.md", "references", "palette.md", "deep", "nested.md", "empty", "run.sh",
      ]);
      // 깊이 0·1·2가 14px 단위로 밀린다.
      const left = (index: number) => $rows[index].style.paddingLeft;
      expect(left(0)).to.equal("0px");      // SKILL.md
      expect(left(2)).to.equal("14px");     // references/palette.md
      expect(left(4)).to.equal("28px");     // references/deep/nested.md
      expect(left(6)).to.equal("0px");      // run.sh
    });

    // 3) 빈 디렉터리는 자기 줄만 있고 아래로 아무 줄도 만들지 않는다.
    fileRows().eq(5).should("contain.text", "empty");
    fileRows().eq(6).should("have.css", "padding-left", "0px");
  });

  it("구성 파일이 없는 스킬은 0개로 알리고 트리 카드에 줄이 서지 않는다", () => {
    stubDetail();
    openSkills();
    openDrawer(BARE);

    metaCells().last().find("strong").should("have.text", "0개");
    drawer().find(".detail-card").last().find(".file-row").should("not.exist");

    // 화면 전환 뒤 앞 스킬의 트리가 남지 않아야 한다 — 드로워는 selected가 바뀌면 다시 그린다.
    drawer().find("[aria-label='닫기']").click();
    cy.get(".drawer").should("not.exist");
    openDrawer(TREE);
    fileRows().should("have.length", 7);
  });

  it("영어 UI에서도 구성 파일 칸과 파일 카드 제목이 영어로 나온다", () => {
    stubDetail();
    openSkills();
    cy.setLanguage("en");
    cy.openView("skills");
    openDrawer(TREE);

    metaCells().last().within(() => {
      cy.get("span").should("have.text", "Files");
      // 영어에서는 단위 "개"를 붙이지 않는다.
      cy.get("strong").should("have.text", "4");
    });

    // 아래 파일 카드 제목은 소스에 한국어 리터럴로만 적혀 있다(SkillsView.tsx:378).
    // 그래도 정적 UI 대응표가 DOM에서 바꿔 주므로 한국어가 남지 않아야 한다
    // (i18nStaticDictionary.ts:42 "파일" → "File").
    drawer().find(".detail-card").last().find(".section-title h3")
      .should("have.text", "File");

    cy.restoreLanguage();
  });
});
