import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// chat.ts는 확장자 없는 타입 import 때문에 node에서 직접 불러올 수 없어 소스 글자로 맞춘다.
// 포크 버튼(supportsSessionFork)이 백엔드 validate_fork_request가 거절할 공급자에게 뜨거나,
// 받는 공급자에게서 사라지는 어긋남을 잡는다.
function frontendForkProviders() {
  const source = readFileSync(new URL("./chat.ts", import.meta.url), "utf8");
  const body = source.match(/function supportsSessionFork\([^)]*\): boolean \{([^}]*)\}/)?.[1];
  assert.ok(body, "supportsSessionFork 본문을 찾지 못했다");
  return [...body.matchAll(/source === "([a-z]+)"/g)].map(([, id]) => id).sort();
}

function backendForkProviders() {
  const source = readFileSync(new URL("../../crates/agent-manager-core/src/chat.rs", import.meta.url), "utf8");
  const body = source.match(/fn validate_fork_request\((?:(?!\nfn )[\s\S])*?matches!\(request\.source,([^)]*)\)/)?.[1];
  assert.ok(body, "validate_fork_request의 공급자 목록을 찾지 못했다");
  return [...body.matchAll(/ProviderId::([A-Za-z]+)/g)].map(([, id]) => id.toLowerCase()).sort();
}

test("포크 버튼을 띄우는 공급자는 백엔드가 fork를 받는 공급자와 같다", () => {
  const backend = backendForkProviders();
  assert.ok(backend.length > 0);
  assert.deepEqual(frontendForkProviders(), backend);
});
