/// <reference types="cypress" />
/**
 * 애드온 → Mermaid 탭의 미리보기 편집기 계약(`MermaidPluginPanel.tsx:79`).
 *
 * 이 탭은 다른 기본도구와 달리 등록·인증·토글이 없고, 대신 원문을 그 자리에서 그려 보는
 * 편집기가 붙어 있다. 기존 시나리오는 애드온 화면의 탭 구분·접근 경로 상세·좁은 화면
 * 배치·다국어와, 마크다운 본문의 mermaid 펜스 렌더(am20260909-markdown-mermaid-diagram)를
 * 다뤘고, **이 탭 안의 편집기 자체**(원문을 고치면 다시 그려지는지, 문법이 아니면 그림
 * 대신 안내가 뜨는지, '예제로 되돌리기'의 잠금, 탭을 다녀온 뒤 원문 잔존)를 본 스펙은 없다.
 *
 * 축은 UI 공통, 조건은 실패 응답의 오류 안내 + 되돌리기 + 화면 전환 후 이전 데이터 잔존.
 *
 * 렌더는 400ms 디바운스(`PREVIEW_DELAY_MS`) 뒤에 엔진을 부르므로 상태 단정은 여유 있는
 * timeout으로 기다린다. 그리기 성패는 `.diagram-viewer[data-state]`로 드러난다
 * (`DiagramViewer.tsx:211`, `:256`).
 */
const PIE = `pie title 분기\n  "승인" : 3\n  "반려" : 1`;
const BROKEN = "flowchart LR\n  A[[[깨진";

function panel() {
  return cy.anchor("addons.mermaid-content");
}

function source() {
  return panel().find('textarea[aria-label="mermaid 원문"]');
}

function viewer() {
  return panel().find(".diagram-viewer");
}

function resetButton() {
  return panel().contains("button", "예제로 되돌리기");
}

/** 디바운스 + 엔진 호출을 감당할 만큼 기다려 그리기 상태를 본다. */
function shouldRenderState(state: "ready" | "invalid") {
  return viewer().should("have.attr", "data-state", state);
}

function typeSource(text: string) {
  source().clear();
  source().type(text, { parseSpecialCharSequences: false, delay: 0 });
}

describe("애드온 Mermaid 탭 미리보기 편집기", () => {
  it("예제가 그려지고, 원문 편집이 다시 그려지며, 문법이 아니면 안내가 뜨고, 되돌리기로 예제가 돌아온다", () => {
    cy.visitApp();
    cy.openAddonsView("mermaid");

    // 1) 탭을 열면 예제(flowchart)가 그려져 있고, 원문이 예제 그대로이므로 되돌리기는 잠겨 있다.
    panel().should("be.visible");
    source().invoke("val").should("contain", "flowchart LR");
    viewer().should("exist");
    shouldRenderState("ready");
    viewer().find("svg").should("exist");
    resetButton().should("be.disabled");

    // 2) 유효한 다른 종류로 바꾸면 디바운스 뒤 다시 그려지고, 원문이 예제와 달라져 되돌리기가 열린다.
    typeSource(PIE);
    resetButton().should("not.be.disabled");
    shouldRenderState("ready");
    viewer().find("svg").should("exist");

    // 3) 문법이 아니면 그림 대신 안내가 뜬다. 원문은 사라지지 않는다.
    typeSource(BROKEN);
    shouldRenderState("invalid");
    panel().contains("mermaid 다이어그램 문법이 아닙니다.").should("be.visible");
    source().invoke("val").should("contain", "깨진");

    // 4) 되돌리기는 원문을 예제로 되돌리고 그림을 되살린 뒤 스스로 다시 잠긴다.
    resetButton().click();
    source().invoke("val").should("contain", "flowchart LR");
    resetButton().should("be.disabled");
    shouldRenderState("ready");
    viewer().find("svg").should("exist");
  });

  it("편집한 원문은 다른 도구 탭과 다른 화면을 다녀와도 남고 그림도 같이 남는다", () => {
    cy.visitApp();
    cy.openAddonsView("mermaid");
    shouldRenderState("ready");

    typeSource(PIE);
    shouldRenderState("ready");

    // 같은 화면 안에서 도구 탭만 옮겼다 돌아온다. 패널은 DOM에 남고 엔진만 멈추는 구조
    // (`MermaidPluginPanel.tsx:118`의 active 분기)이므로 원문과 그림이 그대로 있어야 한다.
    cy.openAddonsTab("ssh");
    cy.openAddonsTab("mermaid");
    source().invoke("val").should("contain", "pie title");
    resetButton().should("not.be.disabled");
    shouldRenderState("ready");
    viewer().find("svg").should("exist");

    // 화면을 떠났다 돌아오는 경우도 본다. 여기서 예제로 되돌아간다면 사용자가 적던 원문이
    // 조용히 사라지는 것이므로 그 자체가 결함이다.
    cy.revisitView("addons");
    cy.openAddonsTab("mermaid");
    source().invoke("val").should("contain", "pie title");
    shouldRenderState("ready");
  });
});

/** V2: 지연 로딩한 로고 팩은 누락 아이콘의 대체 표식 대신 실제 아이콘을 그린다. */
for (const [name, width, height] of [["pc", 1440, 900], ["mobile", 390, 844]] as const) {
  it(`V2: ${name} 아키텍처 다이어그램에 AWS Lambda 아이콘을 그린다`, () => {
    cy.viewport(width, height);
    cy.visitApp();
    cy.openAddonsView("mermaid");
    typeSource("architecture-beta\n  service fn(logos:aws-lambda)[Lambda]");
    // 첫 아키텍처·로고 청크의 지연 로딩이 끝날 때까지 준비 상태를 기다린다.
    panel().find(".diagram-viewer", { timeout: 20_000 }).should("have.attr", "data-state", "ready");
    panel().find(".architecture-service", { timeout: 20_000 })
      .should("have.length", 1)
      .and("contain.text", "Lambda")
      // Lambda 배경의 고유 도형이므로 누락 아이콘의 대체 SVG는 통과하지 못한다.
      .find('svg path[d="M0 0h256v256H0z"]')
      .should("exist");
    cy.screenshot(`logos-runtime-${name}`);
  });
}
