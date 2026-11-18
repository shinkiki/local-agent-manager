/**
 * 마크다운의 mermaid 펜스가 그림이 되는 계약.
 *
 * 이 앱의 마크다운은 자체 렌더러 하나(`MarkdownPreview`)를 열한 화면이 함께 쓴다. 여기서는
 * 그중 가장 적은 준비로 본문을 통째로 정할 수 있는 자리 — 산출물 상세 드로워 — 를 골라
 * 펜스 갈래 네 가지를 한 문서에 담아 확인한다.
 *
 *   ```mermaid          정식 표기. 종류는 코드 첫 줄에 있다              → SVG
 *   ```flowchart LR     종류를 정보 문자열에 적은 표기                   → SVG
 *   ```ts               다이어그램이 아닌 펜스                          → 코드 상자 그대로
 *   ```mermaid (깨진 원문)  엔진이 그릴 수 없는 원문                     → 코드 상자로 되돌림
 *
 * 세 번째·네 번째가 이 스펙의 핵심이다. 다이어그램을 그리려다 실패한 자리에서 내용이
 * 사라지면 문서가 통째로 비어 보인다. 그리지 못하면 반드시 원문이 남아야 한다.
 *
 * `flowchart LR`은 정보 문자열이 한 낱말이 아니라, 예전에는 펜스로 인식조차 되지 않고
 * 코드가 본문 문단으로 새어 나왔다. 그 회귀도 함께 잡는다.
 */
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { diagramPopoutId } from "../../src/lib/diagramPopout";
import type { ArtifactGroup, ArtifactSummary } from "../../src/types";

const CONVERSATION_ID = "conv-mermaid-0001";

const ARTIFACT: ArtifactSummary = {
  conversationId: CONVERSATION_ID,
  rootName: "brain-main",
  name: "diagram.md",
  artifactType: null,
  summary: null,
  updatedAt: 1_757_000_000_000,
  version: 1,
  versions: [1],
  sizeBytes: 512,
};

const SAMPLE: ArtifactGroup[] = [{
  conversationId: CONVERSATION_ID,
  rootName: "brain-main",
  title: "다이어그램 표본",
  readable: true,
  artifacts: [ARTIFACT],
  imageCount: 0,
}];

const BODY = [
  "# 다이어그램",
  "",
  "```mermaid",
  "sequenceDiagram",
  "    사용자->>앱: 문서 열기",
  // 리터럴 역슬래시+n. 에이전트가 실제로 이렇게 쓰는데, 엔진은 시퀀스 메시지에서 이 표기를
  // 글자 그대로 남긴다(흐름도에서는 줄바꿈이 된다). 앱이 `<br/>`로 모아 두 곳을 맞춘다.
  "    앱-->>사용자: 다이어그램\\n두 줄로",
  "```",
  "",
  "```flowchart LR",
  "    시작 --> 끝",
  "```",
  "",
  "```ts",
  "const flowchart = 1;",
  "```",
  "",
  "```mermaid",
  "그런종류의다이어그램은없다",
  "    이건 문법이 아니다",
  "```",
  "",
].join("\n");

const drawer = () => cy.get(".drawer");

/** 표본 문서를 담은 산출물 하나를 상세 드로워에 띄운다. */
function openDiagramDocument(): void {
  cy.stubSnapshotField("artifacts", SAMPLE);
  cy.stubInvoke("get_artifact_detail", {
    statusCode: 200,
    body: { artifact: ARTIFACT, content: BODY },
  }).as("detail");
  cy.visitApp();
  cy.openView("artifacts");
  cy.get('[data-view="artifacts"]:not([hidden]) .artifact-list button').first().click();
  cy.wait("@detail");
}

describe("마크다운 mermaid 다이어그램", () => {
  beforeEach(openDiagramDocument);

  it("mermaid 펜스와 종류를 정보 문자열에 적은 펜스를 그림으로 그린다", () => {
    // 엔진은 첫 다이어그램에서 내려오므로 SVG가 붙기까지 기다린다.
    drawer().find(".markdown-mermaid-canvas svg", { timeout: 20_000 }).should("have.length", 2);

    // 순서대로 시퀀스 다이어그램과 흐름도다. 라벨은 SVG 글자로 들어간다(htmlLabels: false).
    drawer().find('.markdown-mermaid[data-state="ready"]').should("have.length", 2);
    drawer().find(".markdown-mermaid").eq(0).find("svg").should("contain.text", "사용자");
    drawer().find(".markdown-mermaid").eq(1).find("svg").should("contain.text", "시작");
    // 그려진 자리에는 원문 코드 상자가 남지 않는다.
    drawer().find(".markdown-mermaid").eq(0).find("pre.markdown-code-block").should("not.exist");

    // 여는 줄이 본문 문단으로 새지 않는다.
    drawer().find(".markdown-preview").should("not.contain.text", "```");
    drawer().find(".markdown-preview p").should("not.contain.text", "flowchart LR");

    // 리터럴 개행 표기가 글자로 남지 않고 줄로 갈린다.
    drawer().find(".markdown-mermaid-canvas").eq(0).should(($el) => {
      const text = $el[0].textContent ?? "";
      expect(text, "시퀀스 메시지 글자").to.not.include(String.fromCharCode(92) + "n");
      const rows = [...$el[0].querySelectorAll("text, tspan")].map((node) => (node.textContent ?? "").trim());
      expect(rows, "갈라진 줄").to.include("두 줄로");
    });
  });

  it("다이어그램이 아닌 펜스와 그릴 수 없는 원문은 코드 상자로 남는다", () => {
    drawer().find(".markdown-mermaid-canvas svg", { timeout: 20_000 }).should("have.length", 2);

    // ts 펜스는 손대지 않는다 — 언어 표시까지 그대로다.
    drawer().find('pre.markdown-code-block code[data-language="ts"]')
      .should("have.length", 1)
      .and("contain.text", "const flowchart = 1;");

    // 깨진 mermaid 원문은 그림 대신 원문이 남고, 왜 그림이 아닌지 한 줄로 알려 준다.
    drawer().find("pre.markdown-code-block").should("have.length", 2);
    drawer().should("contain.text", "이건 문법이 아니다");
    drawer().find('.markdown-mermaid[data-state="invalid"]').should("have.length", 1)
      .find(".markdown-mermaid-note").should("contain.text", "문법이 아니어서");
    // 그리는 중에 멈춘 자리는 없어야 한다 — 남아 있으면 원문도 그림도 없는 칸이 생긴다.
    drawer().find('.markdown-mermaid[data-state="loading"]').should("not.exist");
  });
});

/**
 * 번들 앱의 CSP는 `tauri.conf.json`에만 있고 dev 서버·이 하네스에는 붙지 않는다. 그래서
 * CSP를 어기는 렌더 경로는 개발·E2E를 전부 통과하고 배포판에서만 죽는다. 여기서는 문서
 * `<head>`에 **설정에 적힌 그대로의** CSP를 meta로 실어 같은 규칙 아래서 다이어그램을
 * 그려 본다. `'unsafe-eval'`이 없는 것이 이 앱 CSP의 핵심이라, eval·new Function을 쓰는
 * 렌더 경로가 들어오면 여기서 SVG가 붙지 않는다.
 *
 * 헤더가 아니라 meta인 이유가 있다. Cypress는 자기 계측을 넣기 위해 응답의
 * `content-security-policy` **헤더를 지운다** — 헤더로 실으면 브라우저에 닿지 않아 이
 * 시나리오가 아무것도 검사하지 않고 통과한다(그 함정을 반증 실행으로 확인했다). 주입한
 * meta는 지우지 않으므로, meta가 문서에 남아 있는지까지 함께 단정해 둔다.
 *
 * CSP 문자열을 스펙에 적지 않고 설정에서 읽는 것도 요점이다. 손으로 옮겨 적으면 설정이
 * 바뀐 뒤에도 이 시나리오는 옛 규칙을 통과시킨다.
 */
const WEBVIEW_CSP = Object.entries(tauriConfig.app.security.csp)
  .map(([directive, value]) => `${directive} ${value}`)
  .join("; ");

describe("번들 앱 CSP 아래의 다이어그램", () => {
  it("설정에 적힌 CSP를 그대로 걸어도 다이어그램이 그려지고 위반이 없다", () => {
    const violations: string[] = [];
    cy.intercept({ method: "GET", url: "/", resourceType: "document" }, (req) => {
      req.continue((res) => {
        res.body = String(res.body).replace(
          "<head>",
          `<head><meta http-equiv="Content-Security-Policy" content="${WEBVIEW_CSP}">`,
        );
      });
    });
    cy.on("window:before:load", (win) => {
      win.addEventListener("securitypolicyviolation", (event) => {
        violations.push(`${event.violatedDirective} ← ${event.blockedURI}`);
      });
    });

    openDiagramDocument();

    // 규칙이 실제로 문서에 걸려 있는지 먼저 본다 — 이게 빠지면 아래 단정은 아무것도 막지 않는다.
    cy.document().should((doc) => {
      const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
      expect(meta, "주입한 CSP meta").to.not.equal(null);
      expect(meta?.getAttribute("content")).to.equal(WEBVIEW_CSP);
    });

    cy.get(".drawer").find(".markdown-mermaid-canvas svg", { timeout: 20_000 }).should("have.length", 2);
    cy.get(".drawer").find(".markdown-mermaid").eq(0).find("svg").should("contain.text", "사용자");

    // 위반이 하나라도 있으면 배포판에서 깨질 자리다 — 어느 지시어가 막았는지 그대로 알린다.
    cy.wrap(null).should(() => {
      expect(violations, `CSP 위반: ${violations.join(", ")}`).to.deep.equal([]);
    });
  });
});

/**
 * 그림 위 도구줄과 확대 보기. 배율·이동·내보내기는 확대 보기와 별도 창이 함께 쓰는 부품이
 * 맡으므로(`DiagramViewer`), 여기서 도구줄이 그 부품을 띄우는 것까지 본다.
 */
describe("다이어그램 도구줄과 확대 보기", () => {
  beforeEach(openDiagramDocument);

  it("도구줄은 그림이 그려진 자리에만 있고 확대보기가 배율을 바꾼다", () => {
    drawer().find(".markdown-mermaid-canvas svg", { timeout: 20_000 }).should("have.length", 2);
    // 그리지 못한 펜스에는 도구줄이 없다 — 없는 그림에 확대·복사를 걸 자리가 없다.
    drawer().find(".markdown-mermaid-shell").should("have.length", 2);
    drawer().find(".markdown-mermaid-actions").should("have.length", 2);

    drawer().find(".markdown-mermaid-actions button[aria-label=확대보기]").first().click({ force: true });
    cy.get(".diagram-modal").should("be.visible").within(() => {
      cy.get(".diagram-viewer-canvas svg", { timeout: 20_000 }).should("exist");
      cy.get(".diagram-viewer-zoom output").should("have.text", "100%");
      cy.get("button[aria-label=확대]").click();
      cy.get(".diagram-viewer-zoom output").should("not.have.text", "100%");
      cy.get("button[aria-label='화면에 맞추기']").click();
      cy.get(".diagram-viewer-zoom output").should("have.text", "100%");
      // 내보내기 버튼은 그림이 붙은 뒤에만 눌릴 수 있다.
      cy.contains("button", "그림 복사").should("not.be.disabled");
    });

    // Esc로 닫으면 본 화면의 그림이 그대로 남는다.
    cy.get("body").type("{esc}");
    cy.get(".diagram-modal").should("not.exist");
    drawer().find(".markdown-mermaid-canvas svg").should("have.length", 2);
  });

  // 확대 수단이 셸마다 다르다. 데스크톱은 휠(트랙패드 두 손가락 포함), 손가락 화면은 두
  // 손가락 핀치다. 프레임이 `touch-action: none`이라 핀치를 우리가 처리하지 않으면 손가락
  // 화면에서는 확대할 방법이 아예 없으므로, 두 경로를 함께 못박는다.
  it("휠과 두 손가락 핀치로 배율이 바뀐다", () => {
    drawer().find(".markdown-mermaid-canvas svg", { timeout: 20_000 }).should("have.length", 2);
    drawer().find(".markdown-mermaid-actions button[aria-label=확대보기]").first().click({ force: true });
    cy.get(".diagram-modal .diagram-viewer-canvas svg", { timeout: 20_000 }).should("exist");

    const frame = () => cy.get(".diagram-modal .diagram-viewer-frame");
    const zoom = () => cy.get(".diagram-modal .diagram-viewer-zoom output");

    // 휠은 굴린 양에 비례해 확대한다(고정 배수가 아니라 지수). 400px이면 e배 남짓이다.
    frame().trigger("wheel", { deltaY: -400, clientX: 500, clientY: 350 });
    zoom().should("have.text", "272%");
    // 반대로 굴리면 되돌아온다.
    frame().trigger("wheel", { deltaY: 400, clientX: 500, clientY: 350 });
    zoom().should("have.text", "100%");

    // 두 손가락을 40px에서 200px로 벌리면 5배가 된다.
    frame()
      .trigger("pointerdown", { pointerId: 11, clientX: 480, clientY: 340, button: 0, buttons: 1 })
      .trigger("pointerdown", { pointerId: 12, clientX: 520, clientY: 340, button: 0, buttons: 1 })
      .trigger("pointermove", { pointerId: 11, clientX: 400, clientY: 340, buttons: 1 })
      .trigger("pointermove", { pointerId: 12, clientX: 600, clientY: 340, buttons: 1 });
    zoom().should("have.text", "500%");

    // 손가락 하나를 떼면 남은 하나로 이동이 이어지고 배율은 그대로다.
    frame()
      .trigger("pointerup", { pointerId: 12 })
      .trigger("pointermove", { pointerId: 11, clientX: 430, clientY: 360, buttons: 1 });
    zoom().should("have.text", "500%");
    frame().trigger("pointerup", { pointerId: 11 });

    cy.get(".diagram-modal button[aria-label='화면에 맞추기']").click();
    zoom().should("have.text", "100%");
  });
});

/**
 * 별도 창. 앱 셸 없이 뜨는 화면이라 백엔드 없이도 그려져야 하고, 원문은 창을 연 화면이
 * 저장소에 두고 간 값을 읽는다. 여기서는 그 저장값을 직접 심어 창 주소로 바로 들어간다.
 */
describe("다이어그램 별도 창", () => {
  const SOURCE = "sequenceDiagram\n    사용자->>앱: 창 열기";
  const id = diagramPopoutId(SOURCE);

  it("저장해 둔 원문으로 그림만 있는 창이 뜬다", () => {
    cy.visit(`/?popout=diagram&diagram=${id}`, {
      onBeforeLoad(win) {
        win.localStorage.setItem(
          `agent-manager.diagram-popout.${id}`,
          JSON.stringify({ source: SOURCE, locale: "ko", savedAt: Date.now() }),
        );
      },
    });

    cy.get(".diagram-window").should("be.visible");
    cy.get(".diagram-viewer-canvas svg", { timeout: 20_000 }).should("contain.text", "사용자");
    // 앱 셸은 뜨지 않는다 — 사이드바도 화면 컨테이너도 없다.
    cy.get("nav").should("not.exist");
    cy.get('[data-view]').should("not.exist");
  });

  it("원문을 찾지 못하면 다시 열라고 알린다", () => {
    cy.visit("/?popout=diagram&diagram=deadbeef");
    cy.get(".diagram-window").should("be.visible").and("contain.text", "다시 열어 주세요");
    cy.get(".diagram-viewer-canvas").should("not.exist");
  });
});
