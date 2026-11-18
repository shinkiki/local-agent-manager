/// <reference types="cypress" />
/**
 * C16-11 · 형상관리 탭의 **git 원격 인증**. 프로젝트 목록 오른쪽 톱니바퀴가 창을 열고, 고른
 * 프로젝트의 HTTPS 원격 호스트마다 저장소 → 비밀정보의 값 하나를 고른다. 지정은 저장된 비밀값이
 * 아니라 프로젝트에 매이고(2026-10-20 결정), 자리는 설정 탭이 아니라 형상관리 탭이다(같은 날 결정).
 *
 * 백엔드는 스텁이다. 스펙이 주장하는 것은 (1) 톱니바퀴가 형상관리 탭에만 서고 설정 탭에는 카드가
 * 없는가, (2) 카드가 HTTPS 원격 호스트만 줄로 세우고 원격이 사라진 지정도 남겨 보이는가, (3) 저장이
 * 값 없이 프로젝트 경로·호스트·이름만 `set_project_git_remote_token`에 보내고(빈 사용자 이름은 null)
 * 그 뒤 형상관리 개요를 다시 읽는가, (4) "사용 안 함"이 secretName null로 해제하는가, (5) 올리기
 * 막힘 안내의 버튼이 같은 창을 여는가, (6) 저장된 비밀값 카드에는 git 원격 칸이 없는가이다.
 */
import { projectEntry, stubProjectRegistry } from "../support/projectRegistryFixtures";
import { gitOverview, gitRepository, stubGitReads } from "../support/gitFixtures";

const ALPHA = "/tmp/amproj/alpha";

const tokens = (list: unknown[] = [], secretNames = ["GH_ME", "GH_ORG"]) => ({
  schemaVersion: 1,
  projectPath: ALPHA,
  tokens: list,
  secretNames,
  defaultUsername: "x-access-token",
});
const binding = (overrides: Record<string, unknown> = {}) => ({
  host: "github.com",
  secretName: "GH_ORG",
  username: "x-access-token",
  updatedAt: 1,
  secretExists: true,
  ...overrides,
});

const card = () => cy.anchor("projects.git.remoteAuthCard");
const row = (host: string) => card().find(`[data-git-auth-host="${host}"]`);

function openGitTab(list: unknown[] = []) {
  stubProjectRegistry([projectEntry("alpha")]);
  stubGitReads({
    overview: gitOverview({
      repository: gitRepository({
        remotes: [
          { name: "origin", url: "https://github.com/o/alpha.git", auth: { transport: "https", host: "github.com", method: list.length ? "token" : "none", tokenSecret: list.length ? "GH_ORG" : null } },
          { name: "plain", url: "http://intranet/alpha.git", auth: { transport: "http", host: "intranet", method: "unknown", tokenSecret: null } },
          { name: "ssh", url: "git@github.com:o/alpha.git", auth: { transport: "ssh", host: "github.com", method: "sshDefault", tokenSecret: null } },
        ],
      }),
    }),
  });
  cy.stubInvoke("list_project_git_remote_tokens", tokens(list)).as("listTokens");
  cy.visitApp();
  cy.openProjectsView("git");
  cy.wait("@gitOverview");
}

function openGitAuth(list: unknown[] = []) {
  openGitTab(list);
  cy.anchor("projects.git.remoteAuth").click();
  cy.wait("@listTokens").its("request.body.request").should("deep.equal", { projectPath: ALPHA });
}

describe("형상관리 · git 원격 인증", () => {
  it("톱니바퀴는 형상관리 탭의 프로젝트 목록 오른쪽에만 서고 설정 탭에는 카드가 없다", () => {
    openGitTab();
    cy.get(".projects-selector-row").within(() => {
      cy.anchor("projects.selector").should("exist");
      cy.anchor("projects.git.remoteAuth").should("be.visible");
    });
    cy.openProjectsTab("files");
    cy.anchor("projects.git.remoteAuth").should("not.exist");
    cy.openProjectsTab("settings");
    cy.anchor("projects.git.remoteAuthCard").should("not.exist");
  });

  it("올리기 막힘 안내의 버튼이 같은 창을 연다", () => {
    openGitTab();
    cy.get(".git-remote-auth").find("button").contains("원격 인증 설정").click();
    cy.wait("@listTokens");
    card().should("be.visible").find("[data-git-auth-host]").should("have.length", 1);
  });

  it("HTTPS 호스트에 저장된 비밀값 이름만 보내 고르고, 저장 뒤 개요를 다시 읽는다", () => {
    openGitAuth();
    card().find("[data-git-auth-host]").should("have.length", 1);
    row("github.com").should("contain", "origin").and("contain", "올리기가 막힙니다");
    row("github.com").find("button").contains("저장").should("be.disabled");
    cy.stubInvoke("set_project_git_remote_token", tokens([binding()])).as("bind");
    row("github.com").find("select").select("GH_ORG");
    // 카드가 줄을 세웠으면 카드 자신의 개요 조회는 끝났다. 여기서 센 뒤로 늘어난 조회가 패널의 재조회다.
    cy.get("@gitOverview.all").then((calls) => {
      const before = calls.length;
      row("github.com").find("button").contains("저장").click();
      cy.wait("@bind").its("request.body.request").then((request) => {
        expect(JSON.parse(JSON.stringify(request))).to.deep.equal({ projectPath: ALPHA, host: "github.com", secretName: "GH_ORG", username: null });
      });
      row("github.com").should("contain", "이 값으로 인증합니다");
      row("github.com").find("select").should("have.value", "GH_ORG");
      cy.get("@gitOverview.all").should("have.length.greaterThan", before);
    });
  });

  it("사용 안 함으로 바꾸면 secretName null로 해제하고, 원격이 사라진 지정도 보인다", () => {
    openGitAuth([binding(), binding({ host: "gone.example.com", secretName: "OLD", secretExists: false })]);
    row("gone.example.com").should("contain", "지워져");
    cy.stubInvoke("set_project_git_remote_token", tokens([binding({ host: "gone.example.com", secretName: "OLD", secretExists: false })])).as("clear");
    row("github.com").find("select").select("사용 안 함");
    row("github.com").find("button").contains("해제").click();
    cy.wait("@clear").its("request.body.request").should("deep.include", { host: "github.com", secretName: null });
  });

  it("저장된 비밀값 카드에는 git 원격 칸이 없다", () => {
    cy.stubInvoke("list_saved_secrets", { statusCode: 200, body: { secrets: [{ name: "GH_ORG", purpose: "github", createdAt: 1, updatedAt: 1, lastUsedAt: null, agentEnabled: true }] } }).as("listSaved");
    cy.stubInvoke("list_all_chat_secrets", { statusCode: 200, body: { chats: [], ttlSeconds: 3600 } });
    cy.visitApp();
    cy.openView("storage");
    cy.anchor("storage.tab.secrets").click();
    cy.wait("@listSaved");
    cy.get(".storage-saved-secrets").should("contain", "GH_ORG");
    cy.get(".storage-secrets-git").should("not.exist");
  });
});
