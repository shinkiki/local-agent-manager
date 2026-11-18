/// <reference types="cypress" />
import { ACCOUNTS, DAY, HOUR, LANG, MIN, NOW, applyGalleryLanguage, localize, shoot, stubWorkspace, tr, visitDark, widenHeadlessWindow, windows } from "../support/releaseGalleryFixtures";
import { providerState, stubProviderAccounts } from "../support/providerAccountFixtures";
import { cypressWorkspace, stubCypressRegistry, stubCypressWorkspaceFiles } from "../support/cypressWorkspaceFixtures";

// ---------------------------------------------------------------------------
// gallery d 전용 데모 데이터

const APP_MANIFEST_URL = "https://raw.githubusercontent.com/shinkiki/local-agent-manager/main/updates/agent-manager.json";

/** 앱 버전 manifest를 현재 버전과 같게 세워 "최신 버전" 줄이 어긋나 보이지 않게 한다. */
function stubAppManifestD(): void {
  cy.intercept("GET", APP_MANIFEST_URL, {
    statusCode: 200,
    body: {
      latestVersion: tr("0.3.0", "0.3.1"),
      releasedAt: new Date(NOW - 2 * DAY).toISOString(),
      releaseNotes: "",
      downloadUrl: "https://github.com/shinkiki/local-agent-manager/releases/latest",
    },
  });
}

/** 모든 계정이 로그인된 상태. 공유 홈 로그인은 활성 계정과 같은 신원이다. */
function stubHealthyAccountsD(): void {
  const accounts = ACCOUNTS.map((account) => ({
    ...account,
    authStatus: "ready",
    credentialExpiresAt: NOW + 24 * DAY,
    runtimeCount: account.isActive ? 2 : 0,
  }));
  const home = (accountId: string, email: string, providerAccountId: string, usage: ReturnType<typeof windows>) => ({
    state: "verified",
    email,
    displayName: null,
    providerAccountId,
    accountId,
    accessTokenExpiresAt: NOW + 6 * HOUR,
    checkedAt: NOW - 3 * MIN,
    retryAt: null,
    error: null,
    usage,
  });
  stubProviderAccounts(
    [
      providerState({ provider: "claude", activeAccountId: "acc-claude-work", observedActiveAccountId: "acc-claude-work", runtimeCount: 2, home: home("acc-claude-work", "dev@example.com", "claude-work", localize(windows(["5시간", 42, 3], ["7일", 58, 71]), LANG)) }),
      providerState({ provider: "codex", activeAccountId: "acc-codex-main", observedActiveAccountId: "acc-codex-main", runtimeCount: 2, home: home("acc-codex-main", "dev@example.com", "codex-main", localize(windows(["5시간", 67, 2], ["7일", 74, 40]), LANG)) }),
    ],
    accounts as never,
  );
}

function cliStatusD(provider: string, displayName: string, path: string, version: string, packageName: string | null) {
  return {
    provider,
    displayName,
    detected: true,
    executablePath: path,
    currentVersion: version,
    versionError: null,
    installSource: "npm",
    packageName,
    updateMethod: "npm",
    updateSupported: true,
    unsupportedReason: null,
    updateCommandLabel: packageName ? `npm install -g ${packageName}@latest` : null,
    manualUpdateHint: "",
    checkSupported: true,
    checkUnsupportedReason: null,
    checked: true,
    latestVersion: version,
    updateAvailable: false,
    checkError: null,
    modelCaches: [],
    modelCacheUnsupportedReason: null,
    modelCacheMismatch: false,
  };
}

function stubCliStatusD(): void {
  cy.stubInvoke("get_cli_update_status", {
    statusCode: 200,
    body: [
      cliStatusD("claude", "Claude Code", "/usr/local/bin/claude", "2.4.1", "@anthropic-ai/claude-code"),
      cliStatusD("codex", "OpenAI Codex", "/usr/local/bin/codex", "0.61.0", "@openai/codex"),
      cliStatusD("antigravity", "Google Antigravity", "/usr/local/bin/agy", "0.11.4", null),
      cliStatusD("local", "Ollama", "/usr/local/bin/opencode", "1.2.7", "opencode-ai"),
    ],
  });
  cy.stubInvoke("get_provider_runtime_counts", (req) => {
    const provider = (req.body as { provider?: string }).provider ?? "claude";
    req.reply({ provider, chatCount: 0, terminalCount: 0, externalProcessCount: 0 });
  });
}

const LOCAL_CONNECTIONS_D = {
  defaultId: "default",
  connections: [
    { id: "default", label: tr("이 기계 Ollama", "This Mac · Ollama"), baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "qwen3:8b", contextWindow: 32768, apiKeyConfigured: false, enabled: true, modelWindows: {} },
    { id: "studio", label: tr("스튜디오 Mac Ollama", "Studio Mac · Ollama"), baseUrl: "http://studio.tailnet-example.ts.net:11434/v1", defaultModel: "gpt-oss:20b", contextWindow: 65536, apiKeyConfigured: false, enabled: true, modelWindows: {} },
    { id: "lab-vllm", label: tr("실험실 vLLM", "Lab vLLM"), baseUrl: "https://llm.lab.example.com/v1", defaultModel: "qwen3-coder:30b", contextWindow: 131072, apiKeyConfigured: true, enabled: false, modelWindows: {} },
  ],
};

function stubLocalLlmD(): void {
  cy.stubInvoke("get_local_llm_connections", { statusCode: 200, body: LOCAL_CONNECTIONS_D });
  cy.stubInvoke("probe_local_llm_connection", (req) => {
    const baseUrl = (req.body as { baseUrl?: string }).baseUrl ?? "";
    const models = baseUrl.includes("studio")
      ? ["gpt-oss:20b", "qwen3:32b", "gemma3:27b", "qwen3:8b"]
      : ["qwen3:8b", "gpt-oss:20b", "llama3.2-vision:11b"];
    req.reply({ reachable: true, models, server: "ollama/0.34.2", error: null });
  });
}

// SSH ----------------------------------------------------------------------

function sshEndpointD(id: string, fingerprint: string, host: string, user: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: "",
    fingerprint,
    host,
    port: 22,
    user,
    agentEnabled: true,
    allowedCommands: ["systemctl status", "journalctl -u", "docker ps", "df -h", "tail"],
    deniedCommands: ["sudo", "rm", "shutdown", "reboot"],
    fileTransferEnabled: false,
    transferRoot: "",
    terminalEnabled: false,
    unrestrictedCommands: false,
    updatedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

const SSH_KEYS_D = [
  {
    fileName: "id_ed25519_staging.pub",
    path: "~/.ssh/id_ed25519_staging.pub",
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:q3Vx8kR2mNf7TcYp4LwZs9HbJd1uEaG6oXi5KyQ0rMs",
    comment: "deploy@agent-manager",
    hasPrivateKey: true,
    note: tr("스테이징 배포 서버", "Staging deploy server"),
    passphraseSaved: false,
  },
  {
    fileName: "id_ed25519_build.pub",
    path: "~/.ssh/id_ed25519_build.pub",
    algorithm: "ssh-ed25519",
    fingerprint: "SHA256:Hc7pT2wLx9Ve4NqRb1ZmK8sYfD3uJo6GaEi0XtP5nQw",
    comment: "ci@build-01",
    hasPrivateKey: true,
    note: tr("빌드 러너 로그 조회", "Build runner logs"),
    passphraseSaved: false,
  },
  {
    fileName: "id_rsa_legacy.pub",
    path: "~/.ssh/id_rsa_legacy.pub",
    algorithm: "ssh-rsa",
    fingerprint: "SHA256:8bNk2QeVr5Lx1Tz7YcWm3HsJp9DaFu4GoKi6XqE0tRy",
    comment: "dev@legacy-bastion",
    hasPrivateKey: true,
    note: null,
    passphraseSaved: true,
  },
];

const SSH_SERVERS_D = [
  sshEndpointD("srv-5d1a9c3e7b20", SSH_KEYS_D[0].fingerprint, "staging.example.com", "deploy", {
    name: tr("스테이징", "Staging"),
    fileTransferEnabled: true,
    transferRoot: "/srv/releases",
    terminalEnabled: true,
  }),
  sshEndpointD("srv-8e4f2b6a0c91", SSH_KEYS_D[1].fingerprint, "build-01.example.com", "ci", {
    allowedCommands: ["docker ps", "docker logs", "df -h", "uptime"],
  }),
  sshEndpointD("srv-2c7d9a1f4e63", SSH_KEYS_D[2].fingerprint, "git-codecommit.ap-northeast-2.amazonaws.com", "APKAEXAMPLE", {
    name: "CodeCommit",
    agentEnabled: false,
    allowedCommands: [],
    projectGitEnabled: true,
  }),
];

function stubSshKeysD(): void {
  cy.stubInvoke("get_ssh_keys", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      body.directoryPath = "~/.ssh";
      body.directoryExists = true;
      body.keygenAvailable = true;
      body.keys = SSH_KEYS_D;
      body.servers = SSH_SERVERS_D;
      body.issues = [];
    });
  });
}

// DB -----------------------------------------------------------------------

function dbConnectionD(overrides: Record<string, unknown>) {
  return {
    id: "db",
    displayName: "",
    engine: "postgres",
    environment: "staging",
    host: "db.staging.example.com",
    port: 5432,
    user: "readonly",
    database: "payments",
    credentialSource: "appKeychain",
    credentialRef: "",
    credentialStoredAt: NOW - 9 * DAY,
    agentEnabled: true,
    writeMode: "readOnly",
    schemaScope: [],
    maskedColumns: ["password", "token", "card_number"],
    maxRows: 200,
    note: "",
    updatedAt: NOW - 3 * DAY,
    ...overrides,
  };
}

const DB_CONNECTIONS_D = [
  dbConnectionD({ id: "payments-staging", displayName: tr("결제 API 스테이징", "Payments API staging"), engine: "postgres", environment: "staging", host: "db.staging.example.com", port: 5432, user: "app_rw", database: "payments", writeMode: "dmlWithApproval", schemaScope: ["public.orders", "public.refunds"], note: tr("주문·환불 데이터 확인용", "For checking order and refund data") }),
  dbConnectionD({ id: "payments-prod", displayName: tr("결제 API 운영", "Payments API production"), engine: "postgres", environment: "production", host: "db.prod.example.com", port: 5432, user: "readonly", database: "payments", writeMode: "readOnly", maxRows: 100, note: tr("운영은 읽기 전용", "Production is read-only") }),
  dbConnectionD({ id: "analytics-mysql", displayName: tr("분석 리플리카", "Analytics replica"), engine: "mysql", environment: "dev", host: "analytics.dev.example.com", port: 3306, user: "analyst", database: "events", credentialSource: "clientFile", credentialRef: "analytics", credentialStoredAt: null, schemaScope: ["events"] }),
  dbConnectionD({ id: "mobile-sqlite", displayName: tr("모바일 앱 로컬 캐시", "Mobile app local cache"), engine: "sqlite", environment: "local", host: "", port: 0, user: "", database: "/workspace/mobile-app/fixtures/cache.sqlite3", credentialSource: "none", credentialStoredAt: null, agentEnabled: false, writeMode: "ddlWithApproval", maskedColumns: [] }),
];

function stubDbConnectionsD(): void {
  cy.stubInvoke("get_db_connections", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      body.connections = DB_CONNECTIONS_D;
      body.issues = [];
    });
  });
}

// 외부 플러그인 ------------------------------------------------------------------

function pluginD(overrides: Record<string, unknown>) {
  return {
    id: "plugin",
    displayName: "",
    names: [],
    url: null,
    auth: "oauth",
    enabled: true,
    scope: null,
    toolPolicies: {},
    credentialReady: true,
    oauthPending: false,
    attachable: true,
    serverName: null,
    tools: [],
    lastVerifiedAt: NOW - 25 * MIN,
    lastError: null,
    authorizedAt: NOW - 12 * DAY,
    accessExpiresAt: NOW + 50 * MIN,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    ...overrides,
  };
}

const PLUGINS_D = [
  pluginD({
    id: "notion", displayName: "Notion", names: tr(["노션"], []), url: "https://mcp.notion.com/mcp", serverName: "notion",
    tools: ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page", "notion-move-pages", "notion-duplicate-page", "notion-create-database", "notion-get-comments", "notion-create-comment"],
    toolPolicies: { "notion-search": "allow", "notion-fetch": "allow", "notion-get-comments": "allow", "notion-move-pages": "deny", "notion-duplicate-page": "deny" },
  }),
  pluginD({
    id: "github", displayName: "GitHub", names: tr(["깃허브"], []), url: "https://api.githubcopilot.com/mcp/", auth: "oauthDevice", serverName: "github",
    tools: ["search_repositories", "get_file_contents", "list_pull_requests", "get_pull_request", "create_issue", "create_pull_request", "merge_pull_request", "list_workflow_runs"],
    toolPolicies: { search_repositories: "allow", get_file_contents: "allow", list_pull_requests: "allow", merge_pull_request: "deny" },
    accessExpiresAt: null,
  }),
  pluginD({
    id: "google-drive", displayName: "Google Drive", names: tr(["구글 드라이브"], []), url: "https://drivemcp.googleapis.com/mcp/v1", serverName: "google-drive",
    tools: ["search_files", "read_file", "list_folder", "create_file"],
    toolPolicies: { search_files: "allow", read_file: "allow", list_folder: "allow" },
  }),
  pluginD({
    id: "google-calendar", displayName: "Google Calendar", names: tr(["구글 캘린더"], []), url: "https://calendarmcp.googleapis.com/mcp/v1", serverName: "google-calendar",
    tools: ["list_events", "get_event", "create_event", "update_event", "delete_event"],
    toolPolicies: { list_events: "allow", get_event: "allow", delete_event: "deny" },
  }),
  pluginD({
    id: "figma", displayName: "Figma", names: tr(["피그마"], []), url: "http://127.0.0.1:3845/mcp", auth: "none", serverName: "figma", enabled: false, attachable: false,
    tools: ["get_design_context", "get_screenshot", "get_variable_defs", "get_metadata"],
    toolPolicies: { get_design_context: "allow", get_screenshot: "allow" },
    lastVerifiedAt: NOW - 3 * DAY, authorizedAt: null, accessExpiresAt: null,
  }),
];

function stubPluginsD(): void {
  cy.stubInvoke("get_external_plugins", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      body.plugins = PLUGINS_D;
      body.proxyReady = true;
      body.nodeAvailable = true;
    });
  });
}

// Cypress ------------------------------------------------------------------

const CY_WORKSPACE_D = cypressWorkspace({
  id: "ws-web",
  name: tr("결제 웹 E2E", "Payments web E2E"),
  path: "/workspace/payments-api/e2e",
  executionType: "standard",
  createdAt: NOW - 20 * DAY,
  moduleReady: true,
  cypressVersion: "15.3.0",
});

const CY_FILES_D = [
  { path: "cypress.config.js", sizeBytes: 612, sensitive: false },
  { path: "cypress.env.json", sizeBytes: 184, sensitive: true },
  { path: "support/e2e.js", sizeBytes: 402, sensitive: false },
  { path: "support/commands.js", sizeBytes: 1_730, sensitive: false },
  { path: "e2e/checkout-flow.cy.js", sizeBytes: 2_940, sensitive: false },
  { path: "e2e/login.cy.js", sizeBytes: 1_210, sensitive: false },
  { path: "e2e/refund-request.cy.js", sizeBytes: 2_310, sensitive: false },
  { path: "e2e/price-crawl.cy.js", sizeBytes: 1_880, sensitive: false },
  { path: "e2e/daily-report-macro.cy.js", sizeBytes: 1_540, sensitive: false },
];

const CY_SPEC_D = tr(`describe("결제 흐름", () => {
  beforeEach(() => {
    cy.login(Cypress.env("DEMO_USER"), Cypress.env("DEMO_PASSWORD"));
  });

  it("장바구니에서 결제까지 완료한다", () => {
    cy.visit("/cart");
    cy.contains("button", "결제하기").click();
    cy.get("[data-test=card-number]").type("4242 4242 4242 4242");
    cy.get("[data-test=card-expiry]").type("12/29");
    cy.contains("button", "주문 확정").click();
    cy.contains("h1", "주문이 완료되었습니다").should("be.visible");
    cy.screenshot("checkout-complete");
  });

  it("쿠폰을 적용하면 합계가 줄어든다", () => {
    cy.visit("/cart");
    cy.get("[data-test=coupon]").type("WELCOME10{enter}");
    cy.get("[data-test=total]").should("contain", "₩45,000");
  });
});
`, `describe("Checkout flow", () => {
  beforeEach(() => {
    cy.login(Cypress.env("DEMO_USER"), Cypress.env("DEMO_PASSWORD"));
  });

  it("completes checkout from the cart", () => {
    cy.visit("/cart");
    cy.contains("button", "Checkout").click();
    cy.get("[data-test=card-number]").type("4242 4242 4242 4242");
    cy.get("[data-test=card-expiry]").type("12/29");
    cy.contains("button", "Place order").click();
    cy.contains("h1", "Your order is confirmed").should("be.visible");
    cy.screenshot("checkout-complete");
  });

  it("applies a coupon and lowers the total", () => {
    cy.visit("/cart");
    cy.get("[data-test=coupon]").type("WELCOME10{enter}");
    cy.get("[data-test=total]").should("contain", "$45.00");
  });
});
`);

function cyRunD(jobId: string, spec: string, state: string, minutesAgo: number, passed: number, failed: number, durationMs: number) {
  return {
    jobId,
    workspaceId: CY_WORKSPACE_D.id,
    spec,
    state,
    startedAt: NOW - minutesAgo * MIN,
    finishedAt: NOW - minutesAgo * MIN + durationMs,
    summary: { passed, failed, pending: 0, durationMs, specs: [], screenshots: [] },
    artifacts: [],
    outputTail: "",
    message: null,
  };
}

function stubCypressD(): void {
  stubCypressRegistry([CY_WORKSPACE_D, cypressWorkspace({ id: "ws-docs", name: tr("문서 사이트 크롤링", "Docs site crawl"), path: "/workspace/docs-site/cypress", createdAt: NOW - 8 * DAY, cypressVersion: "15.3.0" })]);
  stubCypressWorkspaceFiles(CY_FILES_D);
  cy.stubInvoke("read_cypress_workspace_file", (req) => {
    const path = (req.body as { path?: string }).path ?? "e2e/checkout-flow.cy.js";
    const content = path.endsWith("cypress.config.js")
      ? `const { defineConfig } = require("cypress");\n\nmodule.exports = defineConfig({\n  e2e: {\n    baseUrl: "https://staging.example.com",\n    specPattern: "e2e/**/*.cy.js",\n    supportFile: "support/e2e.js",\n  },\n});\n`
      : CY_SPEC_D;
    req.reply({ statusCode: 200, body: { path, content, sensitive: false, masked: false } });
  });
  cy.stubInvoke("list_cypress_runs", {
    statusCode: 200,
    body: [
      cyRunD("run-a", "e2e/checkout-flow.cy.js", "passed", 12, 2, 0, 18_400),
      cyRunD("run-b", "e2e/refund-request.cy.js", "passed", 48, 4, 0, 26_900),
      cyRunD("run-c", "e2e/price-crawl.cy.js", "passed", 95, 1, 0, 71_300),
      cyRunD("run-d", "e2e/login.cy.js", "failed", 180, 2, 1, 9_800),
      cyRunD("run-e", "e2e/daily-report-macro.cy.js", "passed", 1_440, 3, 0, 42_000),
    ],
  });
}

// ---------------------------------------------------------------------------

describe("gallery d", () => {
  before(() => { widenHeadlessWindow(); applyGalleryLanguage(); });
  beforeEach(() => {
    cy.viewport(1440, 900);
    stubWorkspace();
    stubHealthyAccountsD();
    stubCliStatusD();
    stubAppManifestD();
  });

  it("settings-accounts", () => {
    visitDark();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").should("contain.text", tr("Claude 업무", "Claude Work")).and("contain.text", tr("Codex 메인", "Codex Main"));
    cy.contains(tr("저장된 자격증명을 사용할 수 없습니다", "Stored credentials cannot be used")).should("not.exist");
    shoot("settings-accounts");
  });

  it("settings-local-llm", () => {
    stubLocalLlmD();
    visitDark();
    cy.openSettingsTab("connections");
    cy.anchor("settings.connections").contains(".cli-settings-provider", "Ollama")
      .find(".cli-settings-provider-states button.button").click();
    cy.anchor("settings.local-llm").should("exist").and("contain.text", tr("스튜디오 Mac Ollama", "Studio Mac · Ollama"));
    cy.get("[data-connection-id='default']").contains("button", tr("점검", "Check")).click();
    cy.get("[data-connection-id='default']").should("contain.text", tr("닿음", "Reachable"));
    cy.get("[data-connection-id='studio']").contains("button", tr("점검", "Check")).click();
    cy.get("[data-connection-id='studio']").should("contain.text", tr("닿음", "Reachable"));
    cy.anchor("settings.local-llm").scrollIntoView();
    shoot("settings-local-llm");
  });

  it("settings-backend", () => {
    cy.stubInvoke("get_tailscale_service_status", {
      statusCode: 200,
      body: {
        available: true,
        enabled: true,
        host: "agent-manager.tailnet-example.ts.net",
        login: "dev@example.com",
        url: "https://agent-manager.tailnet-example.ts.net",
        servicePort: 4178,
        serveTarget: "http://127.0.0.1:4178",
        conflictTarget: null,
        remoteAccepted: true,
        error: null,
      },
    });
    cy.stubInvoke("get_sleep_prevention", { statusCode: 200, body: { supported: true, enabled: true, active: true, mechanism: "caffeinate", error: null } });
    cy.intercept("GET", "**/api/access", (req) => {
      req.continue((res) => { (res.body as Record<string, unknown>).backendPort = 4178; });
    });
    visitDark();
    cy.openSettingsTab("service");
    cy.contains(".backend-service-toggle", tr("Tailscale 서비스", "Tailscale service")).should("contain.text", "agent-manager.tailnet-example.ts.net");
    cy.contains(".backend-service-toggle", tr("절전 억제", "Prevent sleep")).should("contain.text", "caffeinate");
    // 로그인 항목 행은 데스크톱 셸에서만 값을 읽어 브라우저 하네스에서는 "확인 중…"에 머문다.
    cy.contains(".backend-service-toggle", tr("자동 시작", "at system startup")).invoke("css", "display", "none");
    shoot("settings-backend");
  });

  it("addons-plugins", () => {
    stubPluginsD();
    visitDark();
    cy.openAddonsView("mcp");
    cy.anchor("addons.mcp-content").should("be.visible");
    cy.contains(".plugin-list", "Google Calendar").should("exist");
    cy.anchor("addons.tab.mcp").scrollIntoView();
    shoot("addons-plugins");
  });

  it("addons-ssh", () => {
    stubSshKeysD();
    visitDark();
    cy.openSshKeysTab();
    cy.sshKeyRow("id_ed25519_staging.pub").should("exist");
    shoot("addons-ssh");
  });

  it("addons-db", () => {
    stubDbConnectionsD();
    visitDark();
    cy.openAddonsView("db");
    cy.anchor("addons.db-content").should("be.visible");
    cy.get(".db-connections-card").should("contain.text", tr("결제 API 스테이징", "Payments API staging"));
    shoot("addons-db");
  });

  it("addons-cypress", () => {
    stubCypressD();
    visitDark();
    cy.openAddonsView("cypress");
    cy.get(".cypress-workspace-select").first().click();
    cy.contains("e2e/checkout-flow.cy.js").click();
    cy.contains(tr("장바구니에서 결제까지", "completes checkout from the cart")).should("exist");
    cy.anchor("addons.tab.cypress").scrollIntoView();
    cy.get(".cypress-file-list").scrollTo("top");
    shoot("addons-cypress");
  });
});
