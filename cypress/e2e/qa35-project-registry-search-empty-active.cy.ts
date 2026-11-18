/// <reference types="cypress" />
// QA #35: 프로젝트 화면 → 설정 탭의 프로젝트 활성여부 카드(ProjectRegistryCard.tsx, 예전 설정 → 라이브러리)에서 검색어가
// 제외 프로젝트만 맞히면 활성 목록 자리에 "활성 프로젝트가 없습니다."가 떠, 등록된 활성
// 프로젝트가 아예 없는 것처럼 읽혔다. 검색 중에는 "검색에 맞는 활성 프로젝트가 없습니다."로
// 검색 기준임을 밝히고, 검색을 지우면 원래 문구로 돌아와야 한다.
import type { ProjectRegistryEntry } from "../../src/types";
import {
  openProjectRegistryCard,
  projectEntry as project,
  projectRegistryCard as card,
  stubProjectRegistry,
} from "../support/projectRegistryFixtures";

const search = () => card().find("input.search-input");
const empty = () => card().find(".project-registry-empty");

function openCard(entries: ProjectRegistryEntry[]): void {
  stubProjectRegistry(entries);
  cy.visitApp();
  openProjectRegistryCard();
}

describe("QA #35 · 검색이 제외 프로젝트만 맞힐 때의 활성 목록 문구", () => {
  it("검색 중에는 검색 기준임을 밝히고, 제외 항목은 펼쳐진 목록에 그대로 보인다", () => {
    openCard([project("alpha"), project("gamma-excluded", { active: false })]);
    empty().should("not.exist");

    search().type("gamma");
    empty().should("have.text", "검색에 맞는 활성 프로젝트가 없습니다.");
    empty().should("not.have.text", "활성 프로젝트가 없습니다.");
    // 검색이 맞힌 제외 프로젝트는 자동으로 펼쳐진 목록에 있어 등록 자체가 없는 것이 아님이 드러난다.
    card().find("#project-registry-inactive-list .project-registry-row").should("have.length", 1).and("contain.text", "gamma-excluded");
    // 요약은 등록 전체를 세므로 활성 1이 그대로 남는다.
    card().find(".settings-subsection > header small").should("contain.text", "활성 1");

    search().clear();
    empty().should("not.exist");
    card().find(".project-registry-row:not(.inactive)").should("have.length", 1);
  });

  it("검색이 아닐 때 활성이 하나도 없으면 원래 문구를 그대로 쓴다", () => {
    openCard([project("gamma-excluded", { active: false })]);
    empty().should("have.text", "활성 프로젝트가 없습니다.");
  });
});
