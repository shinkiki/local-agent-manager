import test from "node:test";
import assert from "node:assert/strict";
import { isPluginConnectionChanged, normalizedPluginScope, normalizedPluginUrl } from "./pluginConnectionChange.ts";

const draft = (part = {}) => ({ auth: "oauth", url: "https://mcp.example.com/mcp", clientId: "", clientSecret: "", scope: "read write", ...part });
const current = (part = {}) => ({ auth: "oauth", url: "https://mcp.example.com/mcp", scope: "read write", ...part });

// 백엔드 validate_scope 는 공백을 접고 중복을 빼서 비교한다 — 그 차이만으로 초기화 확인을 띄우지 않는다.
test("scope 공백·중복 차이는 연결 변경이 아니다", () => {
  assert.equal(normalizedPluginScope("  read   write read "), "read write");
  assert.equal(isPluginConnectionChanged(draft({ scope: " read  write read" }), current()), false);
  assert.equal(isPluginConnectionChanged(draft({ scope: "write read" }), current()), true);
  assert.equal(isPluginConnectionChanged(draft({ scope: "read" }), current()), true);
});

// 백엔드는 Url 직렬화 값을 저장·비교한다.
test("URL 호스트 대소문자·빈 경로의 / 차이는 연결 변경이 아니다", () => {
  assert.equal(normalizedPluginUrl(" https://MCP.Example.com "), "https://mcp.example.com/");
  assert.equal(isPluginConnectionChanged(draft({ url: "https://MCP.example.com/mcp" }), current()), false);
  assert.equal(isPluginConnectionChanged(draft({ url: "https://mcp.example.com" }), current({ url: "https://mcp.example.com/" })), false);
  assert.equal(isPluginConnectionChanged(draft({ url: "https://mcp.example.com/other" }), current()), true);
  assert.equal(normalizedPluginUrl("not a url"), "not a url");
});

test("인증 방식·client_id 입력은 그대로 연결 변경이고, 신규 등록은 변경이 아니다", () => {
  assert.equal(isPluginConnectionChanged(draft({ auth: "bearer" }), current()), true);
  assert.equal(isPluginConnectionChanged(draft({ clientId: "abc" }), current()), true);
  assert.equal(isPluginConnectionChanged(draft(), null), false);
  assert.equal(isPluginConnectionChanged(draft({ auth: "notionToken", url: "" }), current({ auth: "notionToken", url: null, scope: null })), false);
});

test("scope 는 OAuth 두 방식에서만 연결 변경이고, 기본 포트 차이는 변경이 아니다", () => {
  assert.equal(isPluginConnectionChanged(draft({ auth: "oauthDevice", scope: "repo" }), current({ auth: "oauthDevice" })), true);
  assert.equal(isPluginConnectionChanged(draft({ auth: "bearer", scope: "x" }), current({ auth: "bearer" })), false);
  assert.equal(isPluginConnectionChanged(draft({ url: "https://mcp.example.com:443/mcp" }), current()), false);
});
