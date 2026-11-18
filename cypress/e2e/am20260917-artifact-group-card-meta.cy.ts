// 산출물 그룹 카드의 메타 표기 경계. 기존 산출물 스펙은 빈 상태(artifacts.cy.ts),
// 검색이 닿는 필드(am20260907-artifacts-search-fields), 드로워 본문·초점·잔존만 봤고,
// 카드 자체가 조건부로 그리는 네 자리 — 최신 시각(모든 updatedAt이 없을 때),
// 이미지 개수 행(imageCount 0/양수), 행의 버전 배지(versions 빈 배열)와 크기 0바이트,
// 요약이 없을 때의 파일명 대체와 미지 타입의 확장자 제거 — 는 어느 시나리오도
// 확인하지 않았다. 영어 전환에서 이 라벨들이 함께 바뀌는지도 처음 본다.
import type { ArtifactGroup, ArtifactSummary } from "../../src/types";

const UPDATED = 1_757_000_000_000;

function artifact(overrides: Partial<ArtifactSummary> & Pick<ArtifactSummary, "name">): ArtifactSummary {
  return {
    conversationId: "conv-meta-0001",
    rootName: "brain-main",
    artifactType: null,
    summary: null,
    updatedAt: null,
    version: null,
    versions: [],
    sizeBytes: 0,
    ...overrides,
  };
}

// locked  시각 없음(updatedAt 전부 null) · 이미지 2개 · 본문 잠김 · 0바이트 · 버전 없음
// plain   시각 있음 · 이미지 0개 · 버전 3개 · 요약 없는 미지 타입 행
const SAMPLE: ArtifactGroup[] = [
  {
    conversationId: "conv-locked-0001",
    rootName: "brain-main",
    title: "시각 없는 대화",
    readable: false,
    artifacts: [
      artifact({ conversationId: "conv-locked-0001", name: "notes.txt" }),
    ],
    imageCount: 2,
  },
  {
    conversationId: "conv-plain-0002",
    rootName: "brain-side",
    title: "평범한 대화",
    readable: true,
    artifacts: [
      artifact({
        conversationId: "conv-plain-0002",
        rootName: "brain-side",
        name: "walkthrough.md",
        artifactType: "ARTIFACT_TYPE_WALKTHROUGH",
        summary: "노션 등록 절차",
        updatedAt: UPDATED,
        version: 3,
        versions: [1, 2, 3],
        sizeBytes: 1536,
      }),
      artifact({
        conversationId: "conv-plain-0002",
        rootName: "brain-side",
        name: "unknown-report.md",
        artifactType: "ARTIFACT_TYPE_SOMETHING_NEW",
        updatedAt: UPDATED,
        sizeBytes: 2048,
      }),
      artifact({
        conversationId: "conv-plain-0002",
        rootName: "brain-side",
        name: "huge-dump.log",
        updatedAt: UPDATED,
        version: 7,
        versions: [7],
        sizeBytes: 1_073_741_824,
      }),
    ],
    imageCount: 0,
  },
];

const groups = () => cy.view("artifacts").find(".artifact-group");
const rows = (index: number) => groups().eq(index).find(".artifact-list button");

function openArtifacts(): void {
  cy.openView("artifacts");
  groups().should("have.length", 2);
}

describe("산출물 그룹 카드의 조건부 메타 표기", () => {
  beforeEach(() => {
    cy.stubSnapshotField("artifacts", SAMPLE);
    cy.visitApp();
  });

  it("모든 아티팩트에 시각이 없는 그룹은 헤더에 상대 시각을 그리지 않는다", () => {
    openArtifacts();
    // 시각 자리는 <time>이다. 값이 없다고 "–"를 흘리지 않고 아예 빠져야 한다.
    groups().eq(0).find("header .artifact-meta time").should("not.exist");
    groups().eq(0).find("header .artifact-meta").should("not.contain.text", "–");
    groups().eq(1).find("header .artifact-meta time").should("exist").and("not.have.text", "–");
  });

  it("이미지 개수 행은 이미지가 있는 그룹에만 붙는다", () => {
    openArtifacts();
    groups().eq(0).find(".image-count").should("have.text", "이미지 2개");
    groups().eq(1).find(".image-count").should("not.exist");
  });

  it("버전 배지는 버전이 있는 행에만 붙고 크기는 0바이트도 적는다", () => {
    openArtifacts();
    rows(0).should("have.length", 1);
    rows(0).find(".artifact-file-meta span").should("have.length", 1).and("have.text", "0 B");
    rows(1).eq(0).find(".artifact-file-meta span").should("have.length", 2);
    rows(1).eq(0).find(".artifact-file-meta").should("contain.text", "1.5 KB").and("contain.text", "버전 3");
    // 같은 그룹 안이라도 버전이 빈 행에는 배지가 없다.
    rows(1).eq(1).find(".artifact-file-meta span").should("have.length", 1).and("have.text", "2.0 KB");
    // 배지는 보유 개수를 센다 — versions [7]은 버전 번호 7이 아니라 '버전 1'이다.
    rows(1).eq(2).find(".artifact-file-meta").should("contain.text", "1.0 GB").and("contain.text", "버전 1");
  });

  it("요약이 없으면 파일명이 대신 서고 미지 타입은 .md만 떼어 제목이 된다", () => {
    openArtifacts();
    rows(1).eq(1).find("strong").should("have.text", "unknown-report");
    rows(1).eq(1).find("p").should("have.text", "unknown-report.md");
    // 확장자가 마크다운이 아니면 파일명이 그대로 남는다.
    rows(0).find("strong").should("have.text", "notes.txt");
    rows(0).find("p").should("have.text", "notes.txt");
    // 아는 타입은 요약을 그대로 쓴다.
    rows(1).eq(0).find("strong").should("have.text", "워크스루");
    rows(1).eq(0).find("p").should("have.text", "노션 등록 절차");
  });

  it("영어로 바꾸면 잠김·이미지·버전·타입 라벨이 함께 영어가 된다", () => {
    openArtifacts();
    cy.setLanguage("en");
    // 언어 select는 설정 탭에 있어 화면이 옮겨간다. 다시 산출물 화면으로 돌아와서 본다.
    cy.openView("artifacts");
    groups().eq(0).find("header .artifact-meta").should("contain.text", "Content locked").and("not.contain.text", "본문 잠김");
    groups().eq(0).find(".image-count").should("have.text", "Images 2");
    groups().eq(1).find(".artifact-file-meta").eq(0).should("contain.text", "Versions 3").and("not.contain.text", "버전");
    rows(1).eq(0).find("strong").should("have.text", "Walkthrough");
    cy.restoreLanguage();
  });
});
