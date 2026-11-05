import test from "node:test";
import assert from "node:assert/strict";
import { toExternalPluginPayload, usesStaticToken } from "./externalPluginForm.ts";

const draft = (part = {}) => ({
  id: "plugin-id",
  displayName: "  Example MCP  ",
  names: " first, second\nfirst, , third ",
  url: " https://mcp.example.com/mcp ",
  auth: "none",
  token: "synthetic-token",
  clientId: " synthetic-client ",
  clientSecret: " synthetic-client-secret ",
  scope: " read  write read ",
  ...part,
});

test("V2/V4: 공통 입력은 정리하되 식별자는 등록·수정 호출자가 따로 보낸다", () => {
  assert.deepEqual(toExternalPluginPayload(draft()), {
    displayName: "Example MCP",
    names: ["first", "second", "third"],
    url: "https://mcp.example.com/mcp",
    auth: "none",
    token: null,
    clientId: null,
    clientSecret: null,
    scope: null,
  });
});

test("V2/V4: 인증 방식 다섯 가지가 보내는 토큰·OAuth 보조 입력을 구분한다", () => {
  const cases = [
    ["none", null, null, null, null, "https://mcp.example.com/mcp"],
    ["bearer", "synthetic-token", null, null, null, "https://mcp.example.com/mcp"],
    ["notionToken", "synthetic-token", null, null, null, null],
    ["oauth", null, "synthetic-client", "synthetic-client-secret", "read  write read", "https://mcp.example.com/mcp"],
    ["oauthDevice", null, "synthetic-client", "synthetic-client-secret", "read  write read", "https://mcp.example.com/mcp"],
  ];
  for (const [auth, token, clientId, clientSecret, scope, url] of cases) {
    const payload = toExternalPluginPayload(draft({ auth }));
    assert.deepEqual(
      { token: payload.token, clientId: payload.clientId, clientSecret: payload.clientSecret, scope: payload.scope, url: payload.url },
      { token, clientId, clientSecret, scope, url },
      auth,
    );
    assert.equal(payload.auth, auth);
  }
});

test("V2/V4: OAuth의 빈 보조 입력은 null이고 내부 scope 공백·순서는 유지한다", () => {
  for (const auth of ["oauth", "oauthDevice"]) {
    for (const blank of ["", " \t\n "]) {
      const payload = toExternalPluginPayload(draft({ auth, clientId: blank, clientSecret: blank, scope: blank }));
      assert.equal(payload.clientId, null);
      assert.equal(payload.clientSecret, null);
      assert.equal(payload.scope, null);
    }
    assert.equal(toExternalPluginPayload(draft({ auth })).scope, "read  write read");
  }
});

test("V2/V4: 정적 토큰은 공백도 그대로 보내고 빈 문자열만 null로 보낸다", () => {
  for (const auth of ["bearer", "notionToken"]) {
    for (const token of ["", " ", "  synthetic-token\n"]) {
      assert.equal(toExternalPluginPayload(draft({ auth, token })).token, token === "" ? null : token);
    }
  }
});

test("V2/V4: 빈 주소는 Notion 토큰 방식만 null이고 다른 방식은 빈 문자열이다", () => {
  for (const auth of ["none", "bearer", "oauth", "oauthDevice"]) {
    assert.equal(toExternalPluginPayload(draft({ auth, url: " \t " })).url, "", auth);
  }
  assert.equal(toExternalPluginPayload(draft({ auth: "notionToken", url: " \t " })).url, null);
  assert.deepEqual(toExternalPluginPayload(draft({ names: " , \n " })).names, []);
});

test("V2/V4: 요청을 만들어도 입력을 바꾸지 않고 이름 목록을 호출마다 새로 만든다", () => {
  const input = Object.freeze(draft());
  const before = { ...input };
  const first = toExternalPluginPayload(input);
  first.names.push("changed-result");
  assert.deepEqual(input, before);
  assert.deepEqual(toExternalPluginPayload(input).names, ["first", "second", "third"]);
});

test("V2/V4: 토큰 입력·변경 버튼의 정적 토큰 판정은 두 방식에서만 참이다", () => {
  assert.deepEqual(
    ["none", "bearer", "oauth", "oauthDevice", "notionToken"].map(usesStaticToken),
    [false, true, false, false, true],
  );
});
