/**
 * 산출물 상세 드로워의 본문 계약.
 * 기존 artifacts 스펙 둘은 목록 쪽만 본다 — 빈 상태·다국어(artifacts.cy.ts)와 검색이
 * 닿는 필드·드로워가 열린다는 사실(am20260907-artifacts-search-fields.cy.ts)까지다.
 * 드로워를 열고 난 뒤의 본문은 어느 시나리오도 확인하지 않았다. 여기서는 메타 4칸,
 * 요약 섹션의 유무 분기, 확장자로 갈리는 마크다운 렌더 대 원문 그대로 표시,
 * 상세 조회 실패의 오류 안내, Esc 닫기를 본다.
 */
import type { ArtifactGroup, ArtifactSummary } from "../../src/types";

const UPDATED = 1_757_000_000_000;

function artifact(name: string, artifactType: string | null, summary: string | null): ArtifactSummary {
  return {
    conversationId: "conv-detail-0001",
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

// 한 그룹에 두 아티팩트를 둔다. 확장자와 요약 유무만 다르다.
//   plan.md    요약이 있고 마크다운이다  → 요약 섹션 + 마크다운 렌더
//   notes.txt  요약이 없고 마크다운이 아니다 → 요약 섹션 없음 + 원문 그대로
const SAMPLE: ArtifactGroup[] = [
  {
    conversationId: "conv-detail-0001",
    rootName: "brain-main",
    title: "상세 본문 표본",
    readable: true,
    artifacts: [
      artifact("plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", "단계별 반영 순서"),
      artifact("notes.txt", null, null),
    ],
    imageCount: 0,
  },
];

const MARKDOWN_BODY = "# 반영 순서\n\n- 첫째 단계\n- 둘째 단계\n";
const PLAIN_BODY = "# 이건 마크다운이 아니다\n- 그대로 보여야 한다\n";

const drawer = () => cy.get(".drawer");
const openArtifact = (index: number) => {
  cy.openView("artifacts");
  cy.get('[data-view="artifacts"]:not([hidden]) .artifact-list button').eq(index).click();
};

describe("산출물 상세 드로워 본문", () => {
  beforeEach(() => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        (res.body as { artifacts: unknown[] }).artifacts = SAMPLE;
      });
    });
    cy.visitApp();
  });

  it("마크다운 아티팩트는 메타 4칸·요약 섹션과 함께 본문을 마크다운으로 그린다", () => {
    cy.stubInvoke("get_artifact_detail", {
      statusCode: 200,
      body: { artifact: SAMPLE[0].artifacts[0], content: MARKDOWN_BODY },
    }).as("detail");
    openArtifact(0);
    cy.wait("@detail");

    // 드로워 제목은 파일명이 아니라 산출물 종류 이름이다.
    drawer().find(".drawer-title").should("have.text", "구현 계획");

    // 메타는 파일·루트·크기·업데이트 넷이고, 크기는 2048 B를 2.0 KB로 접는다.
    drawer().find(".meta-grid > div").should("have.length", 4);
    drawer().find(".meta-grid").should("contain.text", "plan.md")
      .and("contain.text", "brain-main")
      .and("contain.text", "2.0 KB");

    // 요약이 있으면 요약 섹션이 내용 섹션보다 앞에 선다.
    drawer().find(".detail-card .section-title h3").then(($h) => {
      expect([...$h].map((el) => el.textContent)).to.deep.equal(["요약", "내용"]);
    });
    drawer().should("contain.text", "단계별 반영 순서");

    // 마크다운은 렌더된다 — 원문 <pre>가 아니라 마크다운 미리보기다.
    drawer().find(".markdown-preview").should("exist").and("contain.text", "반영 순서");
    drawer().find("pre.markdown-source").should("not.exist");
    // 헤딩 기호가 화면에 그대로 남지 않는다.
    drawer().find(".markdown-preview").should("not.contain.text", "# 반영 순서");
  });

  it("요약이 없고 확장자가 마크다운이 아니면 요약 섹션이 빠지고 본문은 원문 그대로 나온다", () => {
    cy.stubInvoke("get_artifact_detail", {
      statusCode: 200,
      body: { artifact: SAMPLE[0].artifacts[1], content: PLAIN_BODY },
    }).as("detail");
    openArtifact(1);
    cy.wait("@detail");

    // 종류가 없으면 제목은 파일명 그대로다.
    drawer().find(".drawer-title").should("have.text", "notes.txt");
    drawer().find(".detail-card .section-title h3").should("have.length", 1).and("have.text", "내용");
    drawer().should("not.contain.text", "요약");

    // .txt는 마크다운으로 해석하지 않는다 — 샾까지 글자 그대로다.
    drawer().find("pre.markdown-source").should("contain.text", "# 이건 마크다운이 아니다");
    drawer().find(".markdown-preview").should("not.exist");
  });

  it("상세 조회가 실패하면 오류 배너만 뜨고 내용 섹션은 그리지 않으며 Esc로 닫힌다", () => {
    cy.stubInvoke("get_artifact_detail", {
      statusCode: 500,
      body: { error: "아티팩트를 읽지 못했습니다." },
    }).as("detail");
    openArtifact(0);
    cy.wait("@detail");

    drawer().find(".error-banner").should("contain.text", "아티팩트를 읽지 못했습니다.");
    // 실패했으면 로딩 표시가 남아 있어서도, 빈 내용 섹션이 그려져서도 안 된다.
    drawer().should("not.contain.text", "아티팩트를 읽고 있습니다");
    drawer().find(".detail-card").should("not.exist");

    cy.get("body").type("{esc}");
    cy.get(".drawer").should("not.exist");
    // 목록은 그대로 남는다.
    cy.get('[data-view="artifacts"]:not([hidden]) .artifact-group').should("have.length", 1);
  });
});
