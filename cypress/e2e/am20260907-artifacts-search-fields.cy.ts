// 임시 스펙: 산출물 화면을 "목록이 있는 상태"로 처음 세운다. 기존 artifacts.cy.ts는
// 빈 상태의 카운트·안내·영어 전환만 봤고, 검색이 어떤 필드까지 닿는지(그룹 제목,
// 대화 ID, 아티팩트 파일명, 아티팩트 요약)와 한 아티팩트만 맞아도 그룹이 통째로
// 남는 묶음 단위 필터, 제목 없는 그룹의 대체 표기, 아티팩트 드로워 열기는 어느
// 시나리오도 확인하지 않았다.
import type { ArtifactGroup, ArtifactSummary } from "../../src/types";

const UPDATED = 1_757_000_000_000;

function artifact(
  conversationId: string,
  name: string,
  artifactType: string | null,
  summary: string | null,
): ArtifactSummary {
  return {
    conversationId,
    rootName: "brain-main",
    name,
    artifactType,
    summary,
    updatedAt: UPDATED,
    version: 1,
    versions: [1],
    sizeBytes: 2048,
  };
}

// 세 그룹이 서로 다른 필드로만 검색에 걸리도록 짠 표본.
//   alpha  그룹 제목("릴리스 준비")과 아티팩트 파일명("checklist.md")으로 걸린다
//   beta   제목이 없고 아티팩트 요약("노션 등록 절차")으로만 걸린다
//   gamma  제목·요약이 무관하고 대화 ID 조각("gamma")으로만 걸린다
const SAMPLE: ArtifactGroup[] = [
  {
    conversationId: "conv-alpha-0001",
    rootName: "brain-main",
    title: "릴리스 준비",
    readable: true,
    artifacts: [
      artifact("conv-alpha-0001", "checklist.md", "ARTIFACT_TYPE_TASK", "배포 전 확인 항목"),
      artifact("conv-alpha-0001", "plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", "단계별 반영 순서"),
    ],
    imageCount: 0,
  },
  {
    conversationId: "conv-beta-00002",
    rootName: "brain-main",
    title: null,
    readable: true,
    artifacts: [artifact("conv-beta-00002", "walkthrough.md", "ARTIFACT_TYPE_WALKTHROUGH", "노션 등록 절차")],
    imageCount: 3,
  },
  {
    conversationId: "conv-gamma-0003",
    rootName: "brain-side",
    title: "무관한 대화",
    readable: false,
    artifacts: [artifact("conv-gamma-0003", "notes.txt", null, null)],
    imageCount: 0,
  },
];

const groups = () => cy.get('[data-view="artifacts"]:not([hidden]) .artifact-group');
const count = () => cy.get('[data-view="artifacts"]:not([hidden]) .toolbar-count');
const search = () => cy.get('[data-view="artifacts"]:not([hidden]) .search-input');

function openArtifacts(): void {
  cy.openView("artifacts");
  groups().should("have.length", 3);
}

describe("산출물 검색이 닿는 네 필드와 묶음 단위 필터", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        (res.body as { artifacts: unknown[] }).artifacts = SAMPLE;
      });
    });
    cy.visitApp();
  });

  it("검색어가 없으면 세 그룹이 모두 보이고 카운트는 그룹 수를 센다", () => {
    openArtifacts();
    count().should("have.text", "Antigravity 대화 3개");
    // 카운트는 아티팩트 4개가 아니라 대화(그룹) 3개다.
    cy.get('[data-view="artifacts"]:not([hidden]) .artifact-list button').should("have.length", 4);
  });

  it("제목이 없는 그룹은 '(제목 없음) + 대화 ID 앞 8자'로 표기된다", () => {
    openArtifacts();
    groups().eq(1).find("header strong").should("have.text", "(제목 없음) conv-bet");
    groups().eq(1).find("header code").should("have.text", "conv-beta-00002");
    // 본문이 잠긴 그룹만 잠김 표시를 단다.
    groups().eq(1).find("header .artifact-meta").should("not.contain.text", "본문 잠김");
    groups().eq(2).find("header .artifact-meta").should("contain.text", "본문 잠김");
  });

  it("그룹 제목으로 검색하면 그 그룹만 남고 카운트가 따라 줄어든다", () => {
    openArtifacts();
    search().type("릴리스");
    groups().should("have.length", 1);
    groups().eq(0).find("header strong").should("have.text", "릴리스 준비");
    count().should("have.text", "Antigravity 대화 1개");
  });

  it("아티팩트 요약으로만 걸리는 그룹도 검색된다", () => {
    openArtifacts();
    search().type("노션 등록");
    groups().should("have.length", 1);
    groups().eq(0).find("header code").should("have.text", "conv-beta-00002");
  });

  it("대화 ID 조각으로도 검색되고, 대소문자와 앞뒤 공백은 무시한다", () => {
    openArtifacts();
    search().type("  GAMMA  ");
    groups().should("have.length", 1);
    groups().eq(0).find("header code").should("have.text", "conv-gamma-0003");
  });

  it("아티팩트 파일명 하나만 맞아도 그 그룹의 다른 아티팩트까지 함께 남는다", () => {
    openArtifacts();
    search().type("checklist.md");
    groups().should("have.length", 1);
    // 검색은 그룹 단위라 걸리지 않은 plan.md도 같은 카드 안에 남는다.
    groups().eq(0).find(".artifact-list button").should("have.length", 2);
    groups().eq(0).should("contain.text", "작업 목록");
    groups().eq(0).should("contain.text", "구현 계획");
  });

  it("어디에도 걸리지 않는 검색어는 카운트 0개와 빈 상태 안내를 낸다", () => {
    openArtifacts();
    search().type("존재하지-않는-조각");
    groups().should("not.exist");
    count().should("have.text", "Antigravity 대화 0개");
    // 문구까지는 못 박지 않는다 — 목록이 있는데 검색만 안 걸린 경우와 탐지 0건이
    // 같은 안내를 쓰는 것은 AM-75가 이미 잡아 둔 미종결 결함(QA #17)이다.
    cy.get('[data-view="artifacts"]:not([hidden]) .empty-state').should("exist");
  });

  it("검색어를 지우면 세 그룹이 그대로 돌아온다", () => {
    openArtifacts();
    search().type("릴리스");
    groups().should("have.length", 1);
    search().clear();
    groups().should("have.length", 3);
    count().should("have.text", "Antigravity 대화 3개");
  });

  it("아티팩트를 누르면 드로워가 열리고 제목이 산출물 종류 이름으로 나온다", () => {
    cy.stubInvoke("get_artifact_detail", {
      artifact: SAMPLE[0].artifacts[0],
      content: "# 배포 체크리스트\n\n- 태그 확인\n",
    });
    openArtifacts();
    groups().eq(0).find(".artifact-list button").first().click();
    cy.get(".drawer").should("be.visible");
    cy.get(".drawer").should("contain.text", "작업 목록");
    cy.get(".drawer").should("contain.text", "checklist.md");
    cy.get(".drawer").should("contain.text", "배포 전 확인 항목");
    cy.get(".drawer .markdown-preview").should("contain.text", "배포 체크리스트");
  });

  it("종류가 없는 아티팩트는 파일명을 그대로 이름으로 쓴다", () => {
    openArtifacts();
    groups().eq(2).find(".artifact-list button strong").should("have.text", "notes.txt");
    // 요약이 없으면 파일명으로 대체한다.
    groups().eq(2).find(".artifact-list button p").should("have.text", "notes.txt");
  });

  it("이미지가 있는 그룹만 이미지 개수를 덧붙인다", () => {
    openArtifacts();
    groups().eq(1).find(".image-count").should("have.text", "이미지 3개");
    groups().eq(0).find(".image-count").should("not.exist");
  });

  it("다른 화면에 다녀와도 검색어와 걸러진 목록이 그대로 남는다", () => {
    openArtifacts();
    search().type("릴리스");
    groups().should("have.length", 1);
    cy.openView("dashboard");
    cy.openView("artifacts");
    search().should("have.value", "릴리스");
    groups().should("have.length", 1);
    count().should("have.text", "Antigravity 대화 1개");
  });
});
