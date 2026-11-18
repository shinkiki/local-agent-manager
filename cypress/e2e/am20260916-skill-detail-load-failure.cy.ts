/**
 * 스킬 → 스킬정보 → 설치본 드로워의 **상세 조회 실패와 재진입**.
 *
 * 드로워 본문은 `get_skill_detail` 응답이 와야 그려진다(SkillsView.tsx:344, 조회
 * 수명주기는 useSkillDrawerDetail — SkillsView.tsx:567-583). 그런데 지금까지의 스킬
 * 시나리오는 목록·필터·툴바(AM-9·AM-10·AM-40·AM-108)와 드로워의 사용 설정
 * (am20260914-claude-skill-usage-override)만 봤고, **상세 조회가 실패했을 때** 화면이
 * 무엇을 보여 주는지는 어느 스펙도 확인한 적이 없다. 실패하면 `detail`이 null로 남으므로,
 * 로딩 표시가 영원히 도는지 오류를 알려 주는지가 갈린다.
 *
 * 또 하나 — 드로워는 `selected`가 있을 때만 붙고 닫으면 통째로 사라지므로, 실패한 스킬을
 * 닫고 다른 스킬을 열었을 때 앞 스킬의 오류·본문이 남지 않아야 한다. 훅이 오류 상태를
 * 스스로 지우지 않기 때문에(같은 파일 574줄) 이 초기화는 마운트 경계에만 기대고 있다.
 *
 * 축은 스킬, 조건은 실패 응답의 오류 안내와 화면 전환 뒤 이전 데이터 잔존이다.
 */
import type { SkillSummary } from "../../src/types";

const SKILL_ROOT = "/tmp/am20260916-skills";

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

const ALPHA = skill("alpha", "알파스킬");
const BRAVO = skill("bravo", "브라보스킬");
const SKILLS = [ALPHA, BRAVO];

const FAIL_TEXT = "SKILL.md를 읽지 못했습니다";

const drawer = () => cy.get(".drawer");
const loading = () => cy.contains(".drawer", "SKILL.md를 읽고 있습니다");

/** 알파는 실패, 브라보는 성공으로 답하는 상세 조회. 실패 응답은 호출마다 다시 읽는다. */
function stubDetail(alphaFails: () => boolean): void {
  cy.stubInvoke("get_skill_detail", (req) => {
    const id = (req.body as { id: string }).id;
    if (id === ALPHA.id && alphaFails()) {
      req.reply({ statusCode: 500, body: { error: FAIL_TEXT } });
      return;
    }
    const target = SKILLS.find((entry) => entry.id === id) ?? ALPHA;
    req.reply({
      statusCode: 200,
      body: { skill: target, body: `# ${target.name}\n\n${target.name} 본문입니다.`, files: [] },
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
}

describe("설치 스킬 상세 조회 실패와 드로워 재진입", () => {
  it("실패하면 로딩이 멈추고 백엔드 문구를 그대로 알리며 본문 카드는 서지 않는다", () => {
    stubDetail(() => true);
    openSkills();
    openDrawer(ALPHA);

    // 1) 제목은 고른 스킬 그대로다. 실패해도 어느 스킬을 열었는지는 보여야 한다.
    drawer().find(".drawer-title").should("contain.text", ALPHA.name);

    // 2) 로딩 표시가 영원히 돌지 않고, 백엔드가 준 문구가 배너로 선다.
    loading().should("not.exist");
    drawer().find(".error-banner").should("contain.text", FAIL_TEXT);

    // 3) 본문·설명·파일 카드는 하나도 서지 않는다 — 빈 본문을 진짜 내용처럼 보이면 안 된다.
    drawer().find(".detail-card").should("not.exist");

    // 4) 닫기는 막히지 않는다.
    drawer().find('button[aria-label="닫기"]').click();
    drawer().should("not.exist");
  });

  it("실패한 스킬을 닫고 다른 스킬을 열면 앞의 오류가 남지 않는다", () => {
    stubDetail(() => true);
    openSkills();
    openDrawer(ALPHA);
    drawer().find(".error-banner").should("contain.text", FAIL_TEXT);
    drawer().find('button[aria-label="닫기"]').click();

    // 5) 다음 스킬은 제 본문을 그리고, 앞 스킬의 오류 배너는 따라오지 않는다.
    openDrawer(BRAVO);
    drawer().find(".error-banner").should("not.exist");
    drawer().find(".drawer-title").should("contain.text", BRAVO.name);
    drawer().should("contain.text", "브라보스킬 본문입니다");
    drawer().should("not.contain.text", "알파스킬 본문입니다");
  });

  it("실패한 스킬도 다시 열면 상세를 새로 조회하고, 그때 성공하면 본문이 선다", () => {
    let failing = true;
    stubDetail(() => failing);
    openSkills();
    openDrawer(ALPHA);
    drawer().find(".error-banner").should("contain.text", FAIL_TEXT);
    drawer().find('button[aria-label="닫기"]').click();

    // 6) 일시적 실패였다면 다시 여는 것만으로 회복되어야 한다 — 새로고침을 요구하지 않는다.
    cy.then(() => { failing = false; });
    openDrawer(ALPHA);
    drawer().find(".error-banner").should("not.exist");
    drawer().should("contain.text", "알파스킬 본문입니다");
  });
});
