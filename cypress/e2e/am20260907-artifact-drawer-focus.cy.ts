/// <reference types="cypress" />
// 문서·산출물 축의 키보드 접근성 경계. 목록 버튼에서 상세 드로워를 열었다가
// Esc로 닫으면 키보드 사용자가 이어서 탐색할 수 있도록 시작 버튼으로 초점이 돌아와야 한다.
import type { ArtifactGroup, ArtifactSummary } from "../../src/types";

const artifact: ArtifactSummary = {
  conversationId: "conv-focus-0001",
  rootName: "brain-main",
  name: "plan.md",
  artifactType: "ARTIFACT_TYPE_IMPLEMENTATION_PLAN",
  summary: "초점 복원 표본",
  updatedAt: 1_757_000_000_000,
  version: 1,
  versions: [1],
  sizeBytes: 1024,
};

const sample: ArtifactGroup[] = [{
  conversationId: artifact.conversationId,
  rootName: artifact.rootName,
  title: "키보드 탐색 표본",
  readable: true,
  artifacts: [artifact],
  imageCount: 0,
}];

describe("산출물 상세 드로워를 닫은 뒤 시작 버튼 초점 복원", () => {
  it("키보드로 연 드로워를 Esc로 닫으면 아티팩트 버튼으로 초점이 돌아온다", () => {
    cy.stubInvoke("get_manager_snapshot", (req) => {
      req.continue((res) => {
        (res.body as { artifacts: unknown[] }).artifacts = sample;
      });
    });
    cy.stubInvoke("get_artifact_detail", {
      statusCode: 200,
      body: { artifact, content: "# 계획\n\n본문\n" },
    });
    cy.visitApp();
    cy.openView("artifacts");

    // Cypress의 합성 Enter는 브라우저 기본 click을 발생시키지 않으므로, 버튼에 초점을 둔
    // 상태에서 click으로 같은 활성화 경로를 밟는다. 검증 대상은 닫힘 뒤 초점의 귀환이다.
    cy.get('[data-view="artifacts"] .artifact-list button').as("trigger").focus().click();
    cy.get(".drawer").should("be.visible");
    cy.get("body").type("{esc}");

    cy.get(".drawer").should("not.exist");
    cy.get("@trigger").should("be.focused");
    cy.screenshot("artifact-drawer-focus-restored");
  });
});
