/**
 * 산출물 드로워의 모달 장막과 닫은 뒤의 목록 상태.
 * 기존 산출물 스펙 셋은 목록(artifacts.cy.ts의 빈 상태·다국어), 검색이 닿는 필드
 * (am20260907-artifacts-search-fields.cy.ts), 드로워를 연 뒤의 본문
 * (am20260907-artifact-detail-drawer-body.cy.ts)까지만 본다. 드로워가 열려 있는 동안
 * 배경이 어떻게 막히는지와, 닫고 난 뒤 검색어·선택이 어떤 상태로 돌아오는지는 어느
 * 시나리오도 확인하지 않았다. 화면 검색어 잔존은 am20260906-view-search-retention.cy.ts가
 * 보지만 드로워와 얽히는 자리는 범위 밖이다. 여기서는 (1) 열린 동안 검색 입력과 사이드바가
 * 장막에 덮이는지, (2) 배경 클릭·닫기 버튼으로 닫으면 검색어가 그대로인지, (3) 닫은 뒤 다른
 * 아티팩트를 열면 이전 선택이 남지 않는지, (4) 닫은 뒤에는 화면 전환이 다시 되는지를 본다.
 */
import type { ArtifactGroup, ArtifactSummary } from "../../src/types";

const UPDATED = 1_757_000_000_000;

function artifact(conversationId: string, name: string, artifactType: string | null, summary: string | null): ArtifactSummary {
  return { conversationId, rootName: "brain-main", name, artifactType, summary, updatedAt: UPDATED, version: 1, versions: [1], sizeBytes: 2048 };
}

const PLAN = artifact("conv-alpha-0001", "plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", "단계별 반영 순서");
const WALKTHROUGH = artifact("conv-alpha-0001", "walkthrough.md", "ARTIFACT_TYPE_WALKTHROUGH", "노션 등록 절차");

const SAMPLE: ArtifactGroup[] = [
  { conversationId: "conv-alpha-0001", rootName: "brain-main", title: "릴리스 준비", readable: true, artifacts: [PLAN, WALKTHROUGH], imageCount: 0 },
  { conversationId: "conv-beta-00002", rootName: "brain-main", title: "회의 정리", readable: true, artifacts: [artifact("conv-beta-00002", "notes.md", null, "회의 메모")], imageCount: 0 },
];

const groups = () => cy.get('[data-view="artifacts"]:not([hidden]) .artifact-group');
const search = () => cy.get('[data-view="artifacts"]:not([hidden]) .search-input');
const drawer = () => cy.get(".drawer");

/** 요소 한가운데의 최상단 노드가 모달 장막인지 본다. pointer-events 때문에 be.visible로는 갈리지 않는다. */
function coveredByBackdrop(selector: string, covered: boolean): void {
  cy.get(selector).then(($el) => {
    const rect = $el[0].getBoundingClientRect();
    cy.document().then((doc) => {
      const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      expect(Boolean(top?.closest(".drawer-backdrop")), `${selector} covered`).to.eq(covered);
    });
  });
}

function openArtifact(index: number): void {
  cy.get('[data-view="artifacts"]:not([hidden]) .artifact-list button').eq(index).click();
  cy.wait("@detail");
}

describe("산출물 드로워의 모달 장막과 닫은 뒤의 목록 상태", () => {
  beforeEach(() => {
    cy.stubSnapshotField("artifacts", SAMPLE);
    cy.stubInvoke("get_artifact_detail", { statusCode: 200, body: { artifact: PLAN, content: "# 계획\n\n첫 단계는 준비다.\n" } }).as("detail");
    cy.visitApp();
    cy.openView("artifacts");
    groups().should("have.length", 2);
  });

  it("드로워가 열린 동안 검색 입력과 사이드바 메뉴는 장막에 덮인다", () => {
    coveredByBackdrop('[data-view="artifacts"]:not([hidden]) .search-input', false);
    openArtifact(0);
    drawer().find(".drawer-title").should("have.text", "구현 계획");
    coveredByBackdrop('[data-view="artifacts"]:not([hidden]) .search-input', true);
    coveredByBackdrop('[data-ui-anchor="nav.sessions"]', true);
  });

  it("배경을 클릭하면 드로워만 닫히고 검색어와 걸러진 목록은 그대로다", () => {
    search().type("릴리스");
    groups().should("have.length", 1);
    openArtifact(0);
    drawer().should("be.visible");
    cy.get(".drawer-backdrop").click("topLeft");
    cy.get(".drawer").should("not.exist");
    search().should("have.value", "릴리스");
    groups().should("have.length", 1);
  });

  it("닫기 버튼으로 닫고 다른 아티팩트를 열면 이전 선택이 남지 않는다", () => {
    openArtifact(0);
    drawer().find(".drawer-title").should("have.text", "구현 계획");
    drawer().find('.drawer-header button[aria-label="닫기"]').click();
    cy.get(".drawer").should("not.exist");

    cy.stubInvoke("get_artifact_detail", { statusCode: 200, body: { artifact: WALKTHROUGH, content: "워크스루 본문" } }).as("detail");
    openArtifact(1);
    drawer().find(".drawer-title").should("have.text", "워크스루");
    drawer().find(".meta-grid").should("contain.text", "walkthrough.md").and("not.contain.text", "plan.md");
  });

  it("드로워를 닫으면 화면 전환이 다시 되고, 돌아와도 검색어만 남고 드로워는 닫힌 채다", () => {
    search().type("릴리스");
    openArtifact(0);
    cy.get("body").type("{esc}");
    cy.get(".drawer").should("not.exist");

    cy.openView("sessions");
    cy.openView("artifacts");
    search().should("have.value", "릴리스");
    groups().should("have.length", 1);
    cy.get(".drawer").should("not.exist");
  });
});
