/**
 * 스킬관리(보관 스킬) 목록이 **화면 밖에서 바뀐 공통 저장소**를 따라가는지.
 *
 * 기존 스킬 스펙들은 모두 한 번 받아 온 목록 안에서의 검색·필터·일괄 작업을 본다. 목록을
 * 언제 다시 읽는가는 아직 아무도 보지 않았는데, 이 화면의 내용은 사용자만 바꾸는 것이
 * 아니다 — AIA가 `create_common_skill`로 보관 스킬을 만들고, 예약 회차가 원본을 고친다.
 * 그 변경이 화면에 닿는 길이 없으면 사용자는 "만들었다는데 목록에 없다"를 본다.
 *
 * 워크플로 화면은 이미 화면 진입마다 다시 읽는다. 스킬 화면도 같은 계약이어야 한다.
 */
import {
  openSkillLibrary,
  skillLibraryFixtures,
  skillLibraryItems,
} from "../support/skillLibraryFixtures";

const { entry, library, providerState } = skillLibraryFixtures("/tmp/am20260914");

const ALPHA = entry("alpha", { common: true, providers: [providerState("claude")] });
const BETA = entry("beta", { common: true, providers: [] });

describe("스킬관리 목록과 화면 밖 변경", () => {
  it("AIA가 만든 보관 스킬은 화면을 다녀오면 목록에 나온다", () => {
    // 응답은 요청 시점의 목록을 읽는다. 테스트 도중 저장소가 늘어나는 상황을 그대로 만든다.
    let entries = [ALPHA];
    cy.stubInvoke("get_skill_library", (req) => { req.reply(library(entries)); });

    openSkillLibrary();
    skillLibraryItems().should("have.length", 1);

    // 여기서부터가 화면 밖의 변경이다 — AIA가 보관 스킬 한 벌을 새로 만든 상태.
    cy.then(() => { entries = [ALPHA, BETA]; });

    cy.revisitView("skills");
    skillLibraryItems().should("have.length", 2);
    skillLibraryItems().contains("beta").should("exist");
  });
});
