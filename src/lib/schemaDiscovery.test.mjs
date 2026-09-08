import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogResetPrompt,
  discoveryRequestKey,
  parseDiscoveryRequests,
  rememberDiscoveryRequests,
  schemaDiscoveryPrompt,
  staleCatalogSources,
} from "./schemaDiscovery.ts";

function options(source, { stale = false, cliVersion = null } = {}) {
  return { source, cliVersion, catalogStale: stale };
}

test("재조사 요청 키는 공급자와 CLI 버전으로 정해진다", () => {
  assert.equal(discoveryRequestKey(options("claude", { cliVersion: "2.1.233" })), "claude:2.1.233");
  // 버전을 모르면 빈 값으로 묶어, 버전이 확인되면 다시 묻는다.
  assert.equal(discoveryRequestKey(options("claude")), "claude:");
  assert.notEqual(
    discoveryRequestKey(options("claude", { cliVersion: "2.1.233" })),
    discoveryRequestKey(options("claude", { cliVersion: "2.2.0" })),
  );
});

test("오래된 카탈로그만 골라내고 읽지 못한 공급자는 건너뛴다", () => {
  const stale = staleCatalogSources([
    options("claude", { stale: true }),
    options("codex"),
    null,
  ]);
  assert.deepEqual(stale.map((item) => item.source), ["claude"]);
});

test("보낸 요청 기록은 저장된 값에서 이어지고 같은 CLI 버전을 다시 묻지 않는다", () => {
  const stale = [options("claude", { stale: true, cliVersion: "2.2.0" })];
  // 첫 판단: 기록이 없으니 요청을 보내고 키를 남긴다.
  const first = rememberDiscoveryRequests(parseDiscoveryRequests(null), stale.map(discoveryRequestKey));
  assert.deepEqual(first, ["claude:2.2.0"]);
  // 재마운트·다른 창에서 다시 판단해도 저장된 기록이 그대로 걸러낸다.
  const reloaded = parseDiscoveryRequests(JSON.stringify(first));
  assert.deepEqual(
    staleCatalogSources(stale).filter((item) => !reloaded.includes(discoveryRequestKey(item))),
    [],
  );
  // CLI가 업데이트되면 키가 바뀌어 다시 묻는다.
  const updated = [options("claude", { stale: true, cliVersion: "2.3.0" })];
  assert.deepEqual(
    staleCatalogSources(updated)
      .filter((item) => !reloaded.includes(discoveryRequestKey(item)))
      .map(discoveryRequestKey),
    ["claude:2.3.0"],
  );
});

test("요청 기록은 중복 없이 쌓이고 형식이 깨지면 비운다", () => {
  assert.deepEqual(rememberDiscoveryRequests(["claude:2.2.0"], ["claude:2.2.0", "codex:1.0"]), [
    "claude:2.2.0",
    "codex:1.0",
  ]);
  // 상한을 넘으면 오래된 기록부터 버린다.
  const many = Array.from({ length: 30 }, (_, index) => `claude:${index}`);
  const capped = rememberDiscoveryRequests([], many);
  assert.equal(capped.length, 24);
  assert.equal(capped.at(-1), "claude:29");
  // 읽을 수 없는 값은 기록이 없는 것으로 본다.
  assert.deepEqual(parseDiscoveryRequests("{"), []);
  assert.deepEqual(parseDiscoveryRequests(JSON.stringify({ claude: true })), []);
  assert.deepEqual(parseDiscoveryRequests(JSON.stringify(["claude:2.2.0", 7])), ["claude:2.2.0"]);
});

test("재조사 요청문은 모델과 추론 수준 조사까지 지시한다", () => {
  const prompt = schemaDiscoveryPrompt(["claude", "codex"]);
  assert.match(prompt, /claude, codex/);
  assert.match(prompt, /propose_chat_settings_schema/);
  assert.match(prompt, /models/);
  assert.match(prompt, /reasoningEfforts/);
  assert.match(prompt, /생략하면 기존 제안을 유지/);
  assert.match(prompt, /빈 배열로 보내면 fields 제안만 제거/);
});

test("되돌리기 요청문은 빈 배열로 제안만 제거하도록 지시한다", () => {
  const prompt = catalogResetPrompt(["claude"]);
  assert.match(prompt, /models: \[\], reasoningEfforts: \[\]/);
  assert.match(prompt, /fields는 넘기지 마세요/);
});
