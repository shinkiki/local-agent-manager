/**
 * 갈라진 사용본의 **방향**이 화면에서 갈라져 보이는지.
 *
 * 기존 스킬 스펙(AM-40 등)은 "원본과 다르다"는 사실 하나만 보고, 그 상태를 전부 '외부 수정
 * 감지'로 불렀다. 그런데 갈라짐에는 방향이 두 개 있다 — 배포가 덜 돼 뒤처진 사본과, 원본보다
 * 나중에 손으로 고친 사본. 조치가 서로 반대인데(앞은 원본 재배포, 뒤는 채택 여부 판단) 한
 * 이름으로 부르면 뒤처진 사본에도 채택이 유일한 출구로 보이고, 누르면 최신 원본이 옛 내용으로
 * 덮인다. 방향별 배지·칩·조치 버튼이 실제로 갈라지는지 화면에서 본다.
 */
import {
  openSkillLibrary,
  skillFilterChipCount as chipCount,
  skillLibraryFixtures,
  skillLibraryItems,
} from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/am20260920");

const SOURCE_MODIFIED_MS = 1_700_000_000_000;

const install = (directory: string, divergence: string, modifiedAtMs: number | null = SOURCE_MODIFIED_MS) => ({
  scope: "personal",
  projectPath: null,
  projectName: null,
  skillId: `install-${divergence}`,
  directory,
  contentDigest: "d2",
  divergent: true,
  divergence,
  modifiedAtMs,
  readOnly: false,
});

const skill = (key: string, divergence: string, installModifiedAtMs: number | null) => entry(key, {
  common: true,
  providers: [providerState("codex", {
    status: "copy",
    divergent: true,
    divergence,
    skillId: `install-${divergence}`,
    installs: [install(`/tmp/am20260920/codex-${key}`, divergence, installModifiedAtMs)],
  })],
});

/**
 * 세 항목이 같은 "갈라짐"이지만 방향이 다르다.
 *   stale    사본이 원본보다 오래됨 → 뒤처짐
 *   edited   사본이 원본보다 나중 → 외부 수정 감지
 *   unknown  사본의 수정 시각을 읽지 못함 → 어느 쪽이 새 내용인지 단정하지 않는다
 * 보관 원본의 수정 시각은 기본 본에 없으므로 여기서 심는다 — 방향 판정의 한쪽 기준이다.
 */
const LIBRARY = (() => {
  const built = library([
    skill("stale", "behind", SOURCE_MODIFIED_MS - 1_000),
    skill("edited", "edited", SOURCE_MODIFIED_MS + 1_000),
    skill("unknown", "unknown", null),
  ]);
  for (const item of built.entries) {
    if (item.common) item.common.modifiedAtMs = SOURCE_MODIFIED_MS;
  }
  return built;
})();

const dialog = () => cy.get(".modal[role='dialog']");
const applyThisVersion = () => cy.get(".skill-divergent-item").contains("button", "이 버전으로 통일");
const discardChanges = () => cy.get(".skill-divergent-item").contains("button", "변경사항 취소");

describe("갈라진 사용본의 방향", () => {
  beforeEach(() => {
    cy.stubInvoke("get_skill_library", LIBRARY);
  });

  it("뒤처진 사본과 외부 수정은 서로 다른 상태로 세어지고 다른 배지로 보인다", () => {
    openSkillLibrary();
    skillLibraryItems().should("have.length", 3);

    // 뒤처짐은 따로 세어진다. 한 이름으로 묶여 있으면 이 칩이 없고 반대쪽이 3이 된다.
    // 방향을 모르는 항목은 판단이 필요한 쪽(외부 수정)에 함께 둔다 — 자동으로 맞출 수 없다.
    chipCount("스킬 상태 필터", "뒤처짐", "1");
    chipCount("스킬 상태 필터", "외부 수정 감지", "2");

    // 목록 행의 사용 토글에 붙는 표시도 방향대로 갈린다. 한 벌로 묶여 있으면 뒤처진
    // 사본에도 외부 수정과 같은 빨간 경고가 붙는다.
    skillLibraryItems().contains(".skill-library-item", "stale")
      .find(".skill-use-toggle.stale").should("exist");
    skillLibraryItems().contains(".skill-library-item", "edited")
      .find(".skill-use-toggle.divergent").should("exist");
  });

  it("뒤처진 사본에는 변경사항 취소가 주 버튼으로 먼저 선다", () => {
    openSkillLibrary();

    skillLibraryItems().contains(".skill-library-item", "stale").click();
    cy.get(".skill-divergent-item").should("have.length", 1);
    cy.get(".skill-divergent-item").contains("button", "변경사항 취소").should("have.class", "primary");
    cy.get(".skill-divergent-item").contains("button", "이 버전으로 통일").should("not.have.class", "primary");
    cy.get(".skill-divergent-hint").should("contain.text", "변경사항 취소");
  });

  /**
   * 채택할지 사람이 정해야 하는 자리에서는 어느 쪽도 주 버튼으로 서지 않는다. 한쪽이
   * 먼저 서면 그게 권장안으로 읽히는데, 방향을 단정할 근거가 없는 자리다.
   */
  it("외부 수정본과 방향 모름에서는 어느 쪽도 주 버튼으로 서지 않는다", () => {
    for (const key of ["edited", "unknown"]) {
      openSkillLibrary();
      skillLibraryItems().contains(".skill-library-item", key).click();
      cy.get(".skill-divergent-item").contains("button", "변경사항 취소").should("not.have.class", "primary");
      cy.get(".skill-divergent-item").contains("button", "이 버전으로 통일").should("not.have.class", "primary");
    }
  });

  /**
   * 조치는 전부 행에 있다. 머리에 전역 버튼을 두면 행의 조치와 같은 호출을 다른 이름으로
   * 부르게 되고, 사용자는 고르기 전에 "이 둘이 뭐가 다르냐"를 먼저 풀어야 한다.
   */
  it("카드 머리에는 조치 버튼이 없다", () => {
    openSkillLibrary();
    skillLibraryItems().contains(".skill-library-item", "unknown").click();
    cy.get(".skill-divergent-item").should("exist");
    cy.get(".section-title-actions").should("not.exist");
  });

  /**
   * 카드의 두 조치 중 보관 원본을 바꾸는 것은 통일뿐인데 혼자 확인 없이 나갔다. 영향이
   * 가장 큰 조치가 가장 조용했던 셈이라, 무엇이 원본이 되는지를 누르기 전에 말한다.
   */
  it("통일은 원본이 바뀐다는 확인을 거쳐 그 사용본을 채택한다", () => {
    cy.stubInvoke("sync_skill_from_install", {
      statusCode: 200,
      body: { key: "edited", sourceDigest: "d2", results: [], report: { key: "edited", sourceDigest: "d2", fileCount: 1, totalBytes: 100, providers: [], issues: [] } },
    }).as("sync");
    openSkillLibrary();
    skillLibraryItems().contains(".skill-library-item", "edited").click();

    applyThisVersion().click();
    dialog().should("contain.text", "새 보관 원본");
    dialog().should("contain.text", "이전 원본은 휴지통");
    dialog().contains("button", "통일").click();

    cy.wait("@sync").its("request.body.request").should((request: Record<string, unknown>) => {
      expect(request.skillId).to.equal("install-edited");
    });
  });

  it("변경사항 취소는 그 자리에만 원본을 덮어쓴다", () => {
    cy.stubInvoke("publish_common_skill", {
      statusCode: 200,
      body: {
        key: "edited",
        sourceDigest: "d1",
        results: [{ provider: "codex", outcome: "replaced", directory: "/tmp/am20260920/codex-edited", message: null }],
        report: { key: "edited", sourceDigest: "d1", fileCount: 1, totalBytes: 100, providers: [], issues: [] },
      },
    }).as("publish");
    openSkillLibrary();
    skillLibraryItems().contains(".skill-library-item", "edited").click();

    // 밀려난 사용본은 휴지통을 거치지 않는다. 누르기 전에 그 사실이 보여야 한다.
    discardChanges().click();
    dialog().should("contain.text", "되돌릴 수 없습니다");
    dialog().contains("button", "되돌리기").click();

    cy.wait("@publish").its("request.body.request").should((request: Record<string, unknown>) => {
      expect(request.key).to.equal("edited");
      expect(request.providers).to.deep.equal(["codex"]);
      expect(request.overwrite).to.equal("replace");
    });
  });
});
