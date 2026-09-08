import assert from "node:assert/strict";
import test from "node:test";
import {
  accountToolBadges,
  accountToolIcon,
  accountToolsFor,
  DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT,
} from "./accountTools.ts";

const tool = (overrides = {}) => ({
  id: `claude:mcp-server:${overrides.service ?? "notion"}`,
  service: "notion",
  label: "Notion",
  kind: "mcpServer",
  attribution: "account",
  configured: true,
  exposed: true,
  access: "unknown",
  ...overrides,
});

const view = (tools, overrides = {}) => ({
  accountId: "a",
  provider: "claude",
  attributionResolved: true,
  tools,
  ...overrides,
});

test("알려진 서비스는 지정 아이콘, 나머지는 종류별 일반 아이콘으로 떨어진다", () => {
  assert.equal(accountToolIcon({ service: "notion", kind: "mcpServer" }), "notebook");
  assert.equal(accountToolIcon({ service: "github", kind: "plugin" }), "repository");
  assert.equal(accountToolIcon({ service: "figma", kind: "plugin" }), "design");
  assert.equal(accountToolIcon({ service: "acme-internal", kind: "connector" }), "connector");
  assert.equal(accountToolIcon({ service: "acme-internal", kind: "mcpServer" }), "mcp");
  assert.equal(accountToolIcon({ service: "acme-internal", kind: "plugin" }), "plugin");
});

test("같은 서비스가 여러 경로로 잡히면 하나로 합치고 가장 강한 귀속을 남긴다", () => {
  const { badges, overflow } = accountToolBadges(view([
    tool({ id: "claude:connector:Notion", kind: "connector", attribution: "unverified" }),
    tool({ id: "claude:mcp-server:notion", attribution: "account" }),
  ]));

  assert.equal(overflow, 0);
  assert.deepEqual(badges.map((badge) => [badge.service, badge.unverified]), [["notion", false]]);
});

test("계정 단위 항목을 앞에 모으고 공용 항목을 뒤로 보낸다", () => {
  const { badges } = accountToolBadges(view([
    tool({ id: "1", service: "vercel", label: "Vercel", attribution: "unverified" }),
    tool({ id: "2", service: "node-repl", label: "Node REPL", attribution: "shared" }),
    tool({ id: "3", service: "notion", label: "Notion", attribution: "account" }),
    tool({ id: "4", service: "figma", label: "Figma", attribution: "account" }),
  ]));

  // 계정 간 차이는 계정 단위 항목에서만 생기므로 한도에 잘려도 먼저 남아야 한다.
  assert.deepEqual(badges.map((badge) => badge.service), ["figma", "notion", "vercel", "node-repl"]);
  assert.deepEqual(badges.map((badge) => badge.unverified), [false, false, true, false]);
});

test("공용 항목은 미확정 항목보다 강한 근거라 병합 시 살아남는다", () => {
  const { badges } = accountToolBadges(view([
    tool({ id: "1", service: "computer-use", label: "Computer Use", kind: "connector", attribution: "unverified" }),
    tool({ id: "2", service: "computer-use", label: "Computer Use", kind: "plugin", attribution: "shared" }),
  ]));

  assert.deepEqual(badges.map((badge) => [badge.service, badge.unverified]), [["computer-use", false]]);
});

test("미확정 항목을 지우지 않는다. 확인하지 못한 것과 없는 것은 다르다", () => {
  const { badges } = accountToolBadges(view([
    tool({ id: "1", service: "notion", attribution: "unverified" }),
  ], { attributionResolved: false }));

  assert.deepEqual(badges.map((badge) => [badge.service, badge.unverified]), [["notion", true]]);
});

test("표시 한도를 넘는 도구는 접고 남은 수를 알려준다", () => {
  const many = Array.from({ length: DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT + 3 }, (_, index) =>
    tool({ id: `tool-${index}`, service: `service-${index}`, label: `Service ${index}`, attribution: "shared" }));

  const { badges, overflow } = accountToolBadges(view(many));

  assert.equal(badges.length, DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT);
  assert.equal(overflow, 3);
});

test("노출되지 않거나 서비스 이름이 없는 항목은 배지로 만들지 않는다", () => {
  const { badges } = accountToolBadges(view([
    tool({ id: "1", service: "notion", exposed: false }),
    tool({ id: "2", service: "" }),
  ]));

  assert.deepEqual(badges, []);
});

test("계정 요약이 없으면 빈 배지 목록을 돌려준다", () => {
  assert.deepEqual(accountToolBadges(null), { badges: [], overflow: 0 });
  assert.deepEqual(accountToolBadges(view([])), { badges: [], overflow: 0 });
  assert.equal(accountToolsFor(null, "a"), null);
  assert.equal(accountToolsFor({ accounts: [view([])] }, "b"), null);
  assert.equal(accountToolsFor({ accounts: [view([])] }, "a")?.accountId, "a");
});
