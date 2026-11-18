import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";

describe("애드온 화면", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("addons").should("be.visible");
  });

  it("도구별 탭을 구분한다", () => {
    // 첫 탭은 외부 MCP다 — 애드온은 에이전트가 아니라 붙는 도구로 나뉜다.
    cy.anchor("addons.tab.mcp").should("have.class", "active");
    cy.anchor("addons.mcp-content").should("be.visible");

    cy.anchor("addons.tab.mcp").focus().type("{rightarrow}");
    cy.anchor("addons.tab.ssh").should("have.class", "active").and("be.focused");
    cy.anchor("addons.ssh-content").should("be.visible");
    cy.anchor("addons.mcp-content").should("not.be.visible");

    cy.openAddonsTab("claude");
    cy.anchor("addons.ssh-content").should("not.be.visible");
  });

  // 자동화 탭은 애드온이 아니라 워크플로 화면의 마지막 탭이다. 온보딩 카드가 접힌 채 서고
  // 시작을 눌러야 단계가 열린다는 규칙은 화면을 옮겨도 그대로다.
  it("워크플로 화면의 자동화 탭에서 온보딩 카드는 시작을 눌러야 단계가 열린다", () => {
    cy.openAutomationTab();
    // 온보딩 구역은 회차 목표 카드 아래에 서서 스크롤 상자 밖으로 밀린다.
    cy.anchor("workflows.automation-content").scrollIntoView().should("be.visible").within(() => {
      // 카드는 팩이 선언한 만큼 접힌 채로 서고, 각자 시작 버튼을 가진다. 단계는 시작을 눌러야 열린다.
      cy.get(".aia-onboarding-start").should("have.length.at.least", 2).each(($card) => {
        cy.wrap($card).contains("button", "시작").should("exist");
      });
      cy.get('[aria-current="step"]').should("not.exist");
      cy.contains(".aia-onboarding-start", "QA 워크플로 온보딩").contains("button", "시작").click();
      cy.get('[aria-current="step"]').should("contain.text", "대상 시스템");
      cy.contains("button", "다음").click();
      cy.get('[aria-current="step"]').should("contain.text", "테스트 환경");
      // 마지막 단계의 만들기는 필수 입력이 비어 있는 동안 잠겨 있다.
      cy.contains("button", "회차 운영·생성").click();
      cy.contains("button", "만들기").should("be.disabled");
    });
  });

  it("도구 탭마다 에이전트별 접근 경로를 접힌 상세로 보여 준다", () => {
    // 같은 도구도 AIA는 프록시로, 일반 채팅은 직접 MCP나 시스템 스킬로 붙는다. 그 차이는
    // 카드 본문을 밀어내지 않게 접혀 있어야 하고, 펼치면 에이전트 네 갈래가 모두 보여야 한다.
    cy.openAddonsTab("ssh");
    cy.anchor("addons.ssh.access").should("not.have.attr", "open");
    cy.anchor("addons.ssh.access").find("summary").click();
    cy.anchor("addons.ssh.access").within(() => {
      for (const agent of ["AIA", "클로드", "코덱스", "안티그라비티"]) {
        cy.contains("strong", agent).should("be.visible");
      }
      cy.contains("AIA 시스템 도구").should("be.visible");
      cy.contains("시스템 스킬 · CLI").should("be.visible");
    });
  });

  // C21. 분산처리 탭은 SSH 탭의 서버를 가리키므로, 등록된 서버가 없으면 추가 대신 SSH 탭으로
  // 안내하고, 보낼 프로젝트 폴더 구역은 서버 유무와 무관하게 선다.
  it("분산처리 탭이 실행기와 보낼 프로젝트 폴더 구역을 그린다", () => {
    cy.openAddonsTab("runners");
    cy.anchor("addons.runners-content").within(() => {
      cy.contains("h2", "실행기").should("be.visible");
      cy.contains("보낼 프로젝트 폴더").should("exist");
    });
    cy.anchor("addons.runners.project-add").should("exist");
    // 격리 백엔드는 빈 앱 데이터로 뜨므로 SSH 서버가 없다.
    cy.anchor("addons.runners.add").should("not.exist");
    cy.anchor("addons.runners-content").contains("먼저 SSH 탭에서 서버를 등록하세요").should("exist");
    cy.anchor("addons.runners-content").contains("button", "SSH 탭 열기").click();
    cy.anchor("addons.tab.ssh").should("have.class", "active");
  });

  it("분산처리 탭이 에이전트 사용이 꺼진 서버를 경고하고 남은 서버만 고르게 한다", () => {
    const server = (id: string, name: string, host: string, agentEnabled: boolean) =>
      ({ id, name, host, port: 22, user: "builder", agentEnabled });
    cy.stubInvoke("list_runners", {
      statusCode: 200,
      body: {
        runners: [{
          id: "run-aaaaaaaaaaaa", serverId: "srv-desk", name: "desktop", slots: 4, browsers: 2, enabled: true, note: "",
          updatedAt: 0, serverFound: true, serverName: "desktop", host: "100.86.20.5", port: 2222,
          user: "builder", agentEnabled: false, keyFingerprint: "SHA256:x",
          skipCode: "agentOff", skipReason: "SSH 서버의 에이전트 사용이 꺼져 있습니다",
        }],
        projects: [{ id: "prj-aaaaaaaaaaaa", name: "dead-route-game", root: "/workspace/dead-route-game", exclude: ["_land"] }],
        sshServers: [server("srv-desk", "desktop", "100.86.20.5", false), server("srv-lab", "lab", "10.0.0.9", false)],
        minSlots: 1, maxSlots: 8, defaultSlots: 2, maxBrowsers: 4294967295, issues: [],
      },
    });
    cy.openAddonsTab("runners");
    cy.anchor("addons.runners-content").within(() => {
      cy.contains("article", "desktop").within(() => {
        cy.contains("4자리").should("exist");
        cy.contains("브라우저 2").should("exist");
        cy.contains("에이전트 사용이 꺼져 있어 회차가 쓰지 않음").should("exist");
        cy.contains("builder@100.86.20.5:2222").should("exist");
      });
      cy.contains("article", "dead-route-game").should("contain.text", "/workspace/dead-route-game").and("contain.text", "_land");
    });
    cy.anchor("addons.runners.add").click();
    cy.anchor("addons.runners-content").find(".db-connection-editor select option").should("have.length", 1).and("contain.text", "lab");
    cy.anchor("addons.runners-content").contains("이 서버는 에이전트 사용이 꺼져 있어 회차가 쓰지 않습니다").should("exist");
  });

  // 보낼 프로젝트는 인덱스 애드온처럼 프로젝트 화면의 활성 프로젝트를 스위치로 고른다. 켜면 이름을
  // 지어 경로와 함께 한 줄을 추가하고, 끄면 그 줄을 뺀다. 목록에 없는 폴더는 직접 등록에 남는다.
  it("분산처리 탭이 활성 프로젝트를 스위치로 골라 보낼 폴더를 추가·삭제한다", () => {
    const snapshot = (projects: { id: string; name: string; root: string; exclude: string[] }[]) => ({
      runners: [], projects, sshServers: [], minSlots: 1, maxSlots: 8, defaultSlots: 2, maxBrowsers: 4294967295, issues: [],
    });
    stubProjectRegistry([
      projectEntry("데드 루트", { path: "/workspace/dead-route-game" }),
      projectEntry("QA Lite", { path: "/workspace/qa-lite" }),
      projectEntry("숨김", { path: "/workspace/hidden", active: false }),
    ]);
    cy.stubInvoke("list_runners", {
      statusCode: 200,
      body: snapshot([
        { id: "prj-aaaaaaaaaaaa", name: "dead-route-game", root: "/workspace/dead-route-game", exclude: ["_land"] },
        { id: "prj-bbbbbbbbbbbb", name: "agent-manager", root: "/workspace/agent-manager/.rounds", exclude: [] },
      ]),
    });
    cy.stubInvoke("add_runner_project", { statusCode: 200, body: snapshot([]) }).as("add");
    cy.stubInvoke("delete_runner_project", { statusCode: 200, body: snapshot([]) }).as("delete");
    cy.openAddonsTab("runners");
    // 목록에 없는 폴더(프로젝트의 하위 폴더 등)는 직접 등록한 폴더로 남는다.
    cy.anchor("addons.runners-content").contains("article", "agent-manager").should("contain.text", "/workspace/agent-manager/.rounds");
    cy.anchor("addons.runners.projects").within(() => {
      cy.get(".project-registry-row").should("have.length", 2);
      cy.contains(".project-registry-row", "숨김").should("not.exist");
      cy.contains(".project-registry-row", "데드 루트").within(() => {
        cy.contains("보내는 중 · 이름 dead-route-game · 제외 _land").should("exist");
        cy.get('[role="switch"]').should("have.attr", "aria-checked", "true");
      });
      cy.contains(".project-registry-row", "QA Lite").within(() => {
        cy.contains("보내지 않음").should("exist");
        cy.get('[role="switch"]').should("have.attr", "aria-checked", "false").click();
      });
    });
    cy.wait("@add").its("request.body").should("deep.equal", { project: { id: null, name: "qa-lite", root: "/workspace/qa-lite", exclude: [] } });
  });

  it("분산처리 탭에서 제외 폴더가 있는 프로젝트를 끄면 묻고 나서 뺀다", () => {
    stubProjectRegistry([projectEntry("데드 루트", { path: "/workspace/dead-route-game" })]);
    cy.stubInvoke("list_runners", {
      statusCode: 200,
      body: {
        runners: [], projects: [{ id: "prj-aaaaaaaaaaaa", name: "dead-route-game", root: "/workspace/dead-route-game", exclude: ["_land"] }],
        sshServers: [], minSlots: 1, maxSlots: 8, defaultSlots: 2, maxBrowsers: 4294967295, issues: [],
      },
    });
    cy.stubInvoke("delete_runner_project", { statusCode: 200, body: { runners: [], projects: [], sshServers: [], minSlots: 1, maxSlots: 8, defaultSlots: 2, maxBrowsers: 4294967295, issues: [] } }).as("delete");
    cy.openAddonsTab("runners");
    // 편집은 경로를 고정하고 이름·제외 폴더만 받는다.
    cy.anchor("addons.runners.projects").contains("button", "편집").click();
    cy.anchor("addons.runners-content").find(".db-connection-editor").within(() => {
      cy.contains("code", "/workspace/dead-route-game").should("exist");
      cy.get('input[placeholder="/workspace/dead-route-game"]').should("not.exist");
      cy.contains("button", "취소").click();
    });
    cy.anchor("addons.runners.projects").find('[role="switch"]').click();
    cy.contains("이 프로젝트를 보내지 않을까요?").should("be.visible");
    cy.contains("button", "보내지 않기").click();
    cy.wait("@delete").its("request.body").should("deep.equal", { id: "prj-aaaaaaaaaaaa" });
  });

  it("분산처리 탭에서 실행기 저장이 실패하면 백엔드 문구를 그대로 보인다", () => {
    cy.stubInvoke("list_runners", {
      statusCode: 200,
      body: {
        runners: [], projects: [],
        sshServers: [{ id: "srv-lab", name: "lab", host: "10.0.0.9", port: 22, user: "builder", agentEnabled: true }],
        minSlots: 1, maxSlots: 8, defaultSlots: 2, maxBrowsers: 4294967295, issues: [],
      },
    });
    cy.stubInvoke("save_runner", { statusCode: 409, body: { error: "이 SSH 서버는 이미 실행기 lab로 등록되어 있습니다" } }).as("save");
    cy.openAddonsTab("runners");
    cy.anchor("addons.runners.add").click();
    cy.anchor("addons.runners.save").should("be.enabled").click();
    cy.wait("@save").its("request.body").should("deep.include", { runner: { id: null, serverId: "srv-lab", name: "", slots: 2, browsers: 0, enabled: true, note: "" } });
    // 브라우저 자리에는 상한이 없다(u32 끝) — 안내는 "0 이상", 큰 값도 저장되고, 비우면 저장이 꺼진다.
    cy.anchor("addons.runners-content").contains("0 이상.").should("exist");
    cy.anchor("addons.runners-content").contains("label", "브라우저 자리 수").find("input").clear().type("16");
    cy.anchor("addons.runners.save").should("be.enabled").click();
    cy.wait("@save").its("request.body.runner.browsers").should("eq", 16);
    cy.anchor("addons.runners-content").contains("label", "브라우저 자리 수").find("input").clear();
    cy.anchor("addons.runners.save").should("be.disabled");
    cy.anchor("addons.runners-content").contains("이 SSH 서버는 이미 실행기 lab로 등록되어 있습니다").should("be.visible");
    cy.anchor("addons.runners-content").contains("브라우저 자리 수").should("exist");
    // 실패한 저장은 편집기를 닫지 않아 입력을 고쳐 다시 저장할 수 있다.
    cy.anchor("addons.runners.save").should("exist");
  });

  it("분산처리 탭은 브라우저 자리를 모르는 옛 백엔드에서도 칸을 숨기고 저장한다", () => {
    cy.stubInvoke("list_runners", {
      statusCode: 200,
      body: {
        runners: [], projects: [],
        sshServers: [{ id: "srv-lab", name: "lab", host: "10.0.0.9", port: 22, user: "builder", agentEnabled: true }],
        minSlots: 1, maxSlots: 8, defaultSlots: 2, issues: [],
      },
    });
    cy.stubInvoke("save_runner", { statusCode: 409, body: { error: "거절" } }).as("save");
    cy.openAddonsTab("runners");
    cy.anchor("addons.runners.add").click();
    cy.anchor("addons.runners-content").contains("브라우저 자리 수").should("not.exist");
    cy.anchor("addons.runners.save").should("be.enabled").click();
    cy.wait("@save").its("request.body.runner").should("not.have.property", "browsers");
  });

  it("AIA 화면 안내가 클로드 탭을 연다", () => {
    cy.anchor("nav.dashboard").click();
    cy.e2e()
      .then((hooks) => hooks.showUiGuide({ target: "addons.claude", element: null, note: "여기" }))
      .should("eq", true);
    cy.view("addons").should("exist");
    cy.anchor("addons.tab.claude").should("have.class", "active");
    cy.get(".ui-guide-note").should("contain.text", "여기");
  });

  it("클로드 탭 선택 후 화면을 새로고침해도 클로드 탭이 유지된다", () => {
    cy.openAddonsTab("claude");

    cy.reload();

    cy.view("addons").should("be.visible");
    cy.anchor("addons.tab.claude").should("have.class", "active");
    cy.anchor("addons.claude-plugins-content").should("be.visible");
  });
});
