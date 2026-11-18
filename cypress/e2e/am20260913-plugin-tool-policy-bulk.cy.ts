/**
 * 외부 MCP 플러그인 도구 권한 패널: 일괄 변경 머리줄과 개별 도구 행의 상태 동기화.
 *
 * 일괄 머리줄은 저장된 값이 아니라 "현재 도구가 전부 같은 권한인가"를 매번 다시 셈해서
 * 눌린 버튼을 정한다(ExternalPluginsCard.tsx:847). 하나라도 다르면 아무 버튼도 눌리지
 * 않아야 하고, 전체를 한 번에 바꾸면 개별 행과 머리줄이 함께 따라와야 한다. 목록 상태는
 * 격리 백엔드에 없으므로 도구를 가진 플러그인 하나를 세워 두고, 권한 저장 요청을 받아
 * 다음 조회 응답에 반영한다.
 */

type Policy = "allow" | "ask" | "deny";

const TOOLS = ["create-page", "fetch", "search"];
let policies: Record<string, Policy>;

function pluginView() {
  return {
    id: "notion",
    displayName: "Notion",
    url: "https://mcp.notion.so",
    auth: "oauth",
    enabled: true,
    toolPolicies: { ...policies },
    credentialReady: true,
    oauthPending: false,
    attachable: true,
    serverName: "notion",
    tools: TOOLS,
    lastVerifiedAt: null,
    lastError: null,
    authorizedAt: null,
    accessExpiresAt: null,
    createdAt: 1_757_000_000_000,
    updatedAt: 1_757_000_000_000,
  };
}

function pluginsSnapshot() {
  return {
    plugins: [pluginView()],
    proxyReady: true,
    nodeAvailable: true,
    maxPlugins: 5,
    notionHostedUrl: "https://mcp.notion.so",
    notionLocalPackage: "@notionhq/notion-mcp-server",
    hostedPresets: [],
  };
}

/** 도구 행의 권한 버튼 묶음. 행은 `<code>` 이름으로 찾는다. */
function toolGroup(tool: string) {
  return cy.get(".plugin-tool-row").contains("code", tool).parents(".plugin-tool-row").first().find(".plugin-tool-policy");
}

function bulkGroup() {
  return cy.get(".plugin-tool-policy.plugin-tool-bulk");
}

/** 묶음 안에서 눌린 버튼의 글자. 아무것도 눌리지 않았으면 빈 목록이다. */
function pressedLabels(group: Cypress.Chainable<JQuery<HTMLElement>>) {
  return group.find("button[aria-pressed='true']");
}

describe("외부 MCP 도구 권한 일괄 머리줄과 개별 행의 동기화", () => {
  beforeEach(() => {
    policies = { search: "allow" };
    cy.stubInvoke("get_external_plugins", (req) => { req.reply(pluginsSnapshot()); });
    cy.stubInvoke("set_external_plugin_tool_policy", (req) => {
      const args = req.body as { tool: string; policy: Policy };
      policies[args.tool] = args.policy;
      req.reply(pluginView());
    });
    cy.stubInvoke("set_external_plugin_tool_policies", (req) => {
      const args = req.body as { policy: Policy };
      for (const tool of TOOLS) policies[tool] = args.policy;
      req.reply(pluginView());
    });

    cy.visitApp();
    cy.openAddonsView("mcp");
    cy.anchor("addons.mcp-content").should("be.visible");
    cy.contains(".plugin-list .plugin-row, .plugin-list > *", "Notion").should("exist");
    cy.get(".plugin-tools-toggle").should("contain.text", "3개").click();
    cy.get(".plugin-tools").should("be.visible");
  });

  it("권한이 섞여 있으면 일괄 머리줄은 아무 버튼도 누르지 않고, 전체 제한 뒤에는 세 행과 머리줄이 함께 제한이 된다", () => {
    // 저장되지 않은 도구는 확인(ask)이므로 search만 허용이고 나머지 둘은 확인이다.
    cy.get(".plugin-tool-row").should("have.length", 3);
    pressedLabels(toolGroup("search")).should("have.text", "허용");
    pressedLabels(toolGroup("fetch")).should("have.text", "확인");
    pressedLabels(toolGroup("create-page")).should("have.text", "확인");

    // 섞인 상태에서 일괄 머리줄은 어느 것도 현재값이라고 주장하지 않아야 한다.
    bulkGroup().find("button").should("have.length", 3);
    bulkGroup().find("button[aria-pressed='true']").should("not.exist");

    // 전체 제한은 확인 모달 없이 곧바로 저장된다(허용만 확인을 받는다).
    bulkGroup().contains("button", "전체 제한").click();

    cy.get(".plugin-tool-row").each(($row) => {
      cy.wrap($row).find("button[aria-pressed='true']").should("have.text", "제한");
    });
    pressedLabels(bulkGroup()).should("have.text", "전체 제한");

    // 한 행만 되돌리면 머리줄은 다시 아무 것도 누르지 않은 상태로 돌아간다.
    toolGroup("fetch").contains("button", "확인").click();
    pressedLabels(toolGroup("fetch")).should("have.text", "확인");
    pressedLabels(toolGroup("search")).should("have.text", "제한");
    bulkGroup().find("button[aria-pressed='true']").should("not.exist");
  });
});
