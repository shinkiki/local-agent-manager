// 애드온 → Cypress 패널의 자리 계약: 실행 옵션 토글, 파일 고르개, 긴 산출물 경로.
// 파일이 수십 개인 작업공간에서는 파일 칩이 세로로 늘어나 편집기를 화면 밖으로 밀어냈고,
// 산출물 경로는 `artifacts/runs/<32자리 잡 ID>/…`라 한 줄에 들어가지 않아 패널 오른쪽으로
// 넘쳤다. 목록은 높이를 고정해 스크롤하고 경로는 접두를 뗀 뒤 줄바꿈하도록 바뀌었으므로,
// 좁은 폭에서 가로로 넘치지 않는지와 옵션 토글이 작업공간에 저장되는지를 화면에서 본다.
import {
  cypressWorkspace,
  openCypressWorkspacePanel,
  stubCypressFileRead,
  stubCypressRegistry,
  stubCypressWorkspaceFiles,
} from "../support/cypressWorkspaceFixtures";

describe("Cypress 패널의 실행 옵션·파일 고르개·산출물 경로 자리", () => {
  const workspace = cypressWorkspace();

  const jobId = "9e01fcab6eb04bcca9bad87b7169aa12";
  const specNames = ["login", "smartfarm-genie-frame-qa", "smartfarm-a11y-responsive-qa", "manuals-qa-2-terms-list"];
  const files = [
    { path: "cypress.config.js", sizeBytes: 120, sensitive: false },
    ...Array.from({ length: 24 }, (_, index) => ({
      path: `e2e/${specNames[index % specNames.length]}-${index}.cy.js`,
      sizeBytes: 200,
      sensitive: false,
    })),
  ];

  const finishedRun = {
    jobId,
    workspaceId: workspace.id,
    spec: "e2e/smartfarm-genie-frame-qa.cy.js",
    state: "passed",
    startedAt: 1_757_000_100_000,
    finishedAt: 1_757_000_163_000,
    summary: { passed: 6, failed: 0, pending: 0, durationMs: 63_000, specs: [], screenshots: [] },
    artifacts: [
      { path: `artifacts/runs/${jobId}/prerender-iframe.json`, sizeBytes: 225, kind: "json", content: "{}" },
      { path: `artifacts/runs/${jobId}/screenshots/smartfarm-genie-frame-qa -- 프레임 진입.png`, sizeBytes: 51_200, kind: "image", content: null },
      { path: `artifacts/runs/${jobId}/videos/smartfarm-genie-frame-qa.cy.js.mp4`, sizeBytes: 1_048_576, kind: "video", content: null },
    ],
    outputTail: "",
    message: null,
  };

  const optionCalls: Array<Record<string, unknown>> = [];

  function openPanel() {
    optionCalls.length = 0;
    stubCypressRegistry([workspace]);
    stubCypressWorkspaceFiles(files);
    stubCypressFileRead("cypress.config.js", "module.exports = {};\n");
    cy.stubInvoke("list_cypress_runs", { statusCode: 200, body: [finishedRun] });
    cy.stubInvoke("set_cypress_workspace_options", (req) => {
      optionCalls.push(req.body as Record<string, unknown>);
      req.reply({
        statusCode: 200,
        body: { enabled: true, workspaces: [{ ...workspace, ...req.body }] },
      });
    });
    openCypressWorkspacePanel();
  }

  /** 요소가 제 폭 안에 들어가는지. 가로 스크롤이 생기면 화면 밖으로 밀려난 것이다. */
  function fitsHorizontally(selector: string) {
    cy.get(selector).should(($element) => {
      const element = $element[0];
      expect(element.scrollWidth, `${selector} 가로 넘침`).to.be.at.most(element.clientWidth + 1);
    });
  }

  it("파일이 많아도 목록이 높이를 고정해 스크롤하고 검색으로 좁혀진다", () => {
    openPanel();
    cy.get(".cypress-file-list li").should("have.length", files.length);
    cy.get(".cypress-file-list").should(($list) => {
      const element = $list[0];
      // 목록이 편집기를 밀어내지 않도록 높이를 자르고 그 안에서 스크롤한다.
      expect(element.clientHeight, "목록 높이").to.be.at.most(230);
      expect(element.scrollHeight, "스크롤 내용").to.be.greaterThan(element.clientHeight);
    });

    cy.get(".cypress-file-search input").type("genie");
    cy.get(".cypress-file-list li").should("have.length", 6 + 1);
    // 편집 중인 파일은 검색어에 걸리지 않아도 남는다.
    cy.contains(".cypress-file-list li", "cypress.config.js").should("have.class", "active");
    cy.get(".cypress-file-search > span").should("have.text", "7 / 25개");

    // 아무것도 걸리지 않아도 편집 중인 파일 한 줄만 남아 어느 파일을 고치는 중인지 보인다.
    cy.get(".cypress-file-search input").clear().type("없는파일이름");
    cy.get(".cypress-file-list li").should("have.length", 1).and("contain.text", "cypress.config.js");
    cy.get(".cypress-file-search > span").should("have.text", "1 / 25개");
    cy.get(".cypress-file-active code").should("have.text", "cypress.config.js");
  });

  it("좁은 폭에서도 파일 경로와 산출물 경로가 패널 밖으로 넘치지 않는다", () => {
    cy.viewport(430, 900);
    openPanel();
    cy.contains(".cypress-recent-runs li button", "통과").click();

    cy.get(".cypress-run-result").should("be.visible");
    fitsHorizontally(".cypress-artifacts");
    fitsHorizontally(".cypress-file-picker");
    fitsHorizontally(".cypress-panel");

    // 잡 ID 접두는 목록 위에 한 번만 적고, 각 줄은 그 뒤만 보인다.
    cy.get(".cypress-artifact-root code").should("have.text", `artifacts/runs/${jobId}/`);
    cy.get(".cypress-artifacts .cypress-details summary code").should("have.text", "prerender-iframe.json");
    cy.get(".cypress-artifacts .cypress-artifact-plain")
      .first()
      .should("contain.text", "screenshots/smartfarm-genie-frame-qa -- 프레임 진입.png")
      .and("have.attr", "title", `artifacts/runs/${jobId}/screenshots/smartfarm-genie-frame-qa -- 프레임 진입.png`);
    cy.contains(".cypress-artifacts .cypress-artifact-plain", "videos/").should("contain.text", "video");
  });

  it("실행 옵션 토글은 작업공간에 저장되고 목록 표시로 돌아온다", () => {
    openPanel();
    const options = () => cy.get(".cypress-run-options .cypress-run-option");
    options().should("have.length", 2);
    options().eq(0).should("contain.text", "실행 장면 영상 저장").find(".app-toggle").should("have.attr", "aria-checked", "false");
    options().eq(1).should("contain.text", "브라우저 창 띄우고 실행");

    options().eq(0).find(".app-toggle").click();
    cy.wrap(null).should(() => {
      expect(optionCalls, "저장 요청").to.have.length(1);
      expect(optionCalls[0]).to.deep.equal({ id: workspace.id, recordVideo: true, headed: false, executionType: "standard" });
    });
    // 저장된 값은 작업공간 목록에도 표시로 남는다(목록은 화면 위쪽이라 끌어와서 본다).
    cy.contains(".cypress-workspace-row .project-registry-name .skill-sync-pill", "영상 저장")
      .scrollIntoView()
      .should("be.visible");
    options().eq(0).find(".app-toggle").should("have.attr", "aria-checked", "true");
  });

  it("실행 방식은 표준 실행과 격리 실행 중 명시적으로 고른다", () => {
    openPanel();
    cy.get("#cypress-execution-type")
      .should("have.value", "standard")
      .select("agentManagerIsolated")
      .should("have.value", "agentManagerIsolated");
    cy.wrap(null).should(() => {
      expect(optionCalls, "저장 요청").to.have.length(1);
      expect(optionCalls[0]).to.deep.equal({
        id: workspace.id,
        recordVideo: false,
        headed: false,
        executionType: "agentManagerIsolated",
      });
    });
    cy.contains(".cypress-workspace-row .skill-sync-pill", "격리 실행")
      .scrollIntoView()
      .should("be.visible");
  });
});
