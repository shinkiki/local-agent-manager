import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBackendStoreIdentity,
  currentBackendStoreId,
  currentBackendServicePort,
  DEFAULT_BACKEND_SERVICE_PORT,
  LEGACY_BACKEND_SERVICE_PORT,
  MAX_BACKEND_SERVICE_PORT,
  MIN_BACKEND_SERVICE_PORT,
  resolveBackendHttpUrl,
  resolveBackendWebSocketUrl,
  setBackendServiceIdentity,
  validBackendStoreId,
  validBackendServicePort,
} from "./backend.ts";

const STORE_ID = "7cb5018a-4a90-438a-a2c4-d1fd5c660cec";

test("backend defaults use a private port while preserving the deployed compatibility port", () => {
  assert.equal(DEFAULT_BACKEND_SERVICE_PORT, 54_178);
  assert.equal(LEGACY_BACKEND_SERVICE_PORT, 4_178);
});

test("native shell domain requests use the initialized custom loopback port", () => {
  const location = { protocol: "http:", host: "localhost:1420" };
  setBackendServiceIdentity(4319, STORE_ID);

  assert.equal(currentBackendServicePort(), 4319);
  assert.equal(currentBackendStoreId(), STORE_ID);

  assert.equal(
    resolveBackendHttpUrl("/api/access", true, location, 4319),
    "http://127.0.0.1:4319/api/access",
  );
  assert.equal(
    resolveBackendWebSocketUrl("api/chat", true, location, 4319),
    "ws://127.0.0.1:4319/api/chat",
  );
});

test("browser requests stay on the page backend and preserve secure WebSockets", () => {
  const location = { protocol: "https:", host: "manager.example.ts.net" };

  assert.equal(
    resolveBackendHttpUrl("api/invoke/get_manager_snapshot", false, location),
    "https://manager.example.ts.net/api/invoke/get_manager_snapshot",
  );
  assert.equal(
    resolveBackendWebSocketUrl("/api/terminal", false, location),
    "wss://manager.example.ts.net/api/terminal",
  );
});

test("backend service ports reject missing, privileged, non-integer, and overflowing values", () => {
  const location = { protocol: "http:", host: "localhost:1420" };
  const invalidPorts = [undefined, null, "4178", Number.NaN, 1023, 65_536, 4178.5];

  for (const port of invalidPorts) {
    assert.throws(
      () => resolveBackendHttpUrl("/api/access", true, location, port),
      /1024~65535/,
    );
  }
  assert.throws(() => setBackendServiceIdentity(0, STORE_ID), /1024~65535/);
  assert.equal(currentBackendServicePort(), 4319);
  assert.equal(validBackendServicePort(MIN_BACKEND_SERVICE_PORT), MIN_BACKEND_SERVICE_PORT);
  assert.equal(validBackendServicePort(MAX_BACKEND_SERVICE_PORT), MAX_BACKEND_SERVICE_PORT);
});

test("backend store IDs are canonical and native identity mismatches fail closed", () => {
  const otherStoreId = "0c77e0b5-85ee-4477-97e7-83e617adad5b";

  assert.equal(validBackendStoreId(STORE_ID), STORE_ID);
  assert.equal(assertBackendStoreIdentity(STORE_ID, STORE_ID), STORE_ID);
  assert.equal(assertBackendStoreIdentity(STORE_ID, null), STORE_ID);
  assert.throws(() => validBackendStoreId("not-a-uuid"), /식별자/);
  assert.throws(() => validBackendStoreId(STORE_ID.toUpperCase()), /식별자/);
  assert.throws(
    () => assertBackendStoreIdentity(otherStoreId, STORE_ID),
    /다른 백엔드 서비스/,
  );
});

test("C20: the session token rides only on WebSocket and asset URLs, as a query parameter", () => {
  const location = { protocol: "https:", host: "manager.example.ts.net" };
  const token = "abc.def_GHI";

  // fetch 경로는 헤더로 싣는다 — URL은 그대로다.
  assert.equal(
    resolveBackendHttpUrl("/api/invoke/get_manager_snapshot", false, location, undefined, token),
    "https://manager.example.ts.net/api/invoke/get_manager_snapshot",
  );
  assert.equal(
    resolveBackendHttpUrl("/api/access", false, location, undefined, token),
    "https://manager.example.ts.net/api/access",
  );
  // 헤더를 못 붙이는 WebSocket·<img> 자산만 쿼리로 싣고, 기존 쿼리는 보존한다.
  assert.equal(
    resolveBackendWebSocketUrl("/api/chat", false, location, undefined, token),
    "wss://manager.example.ts.net/api/chat?session=abc.def_GHI",
  );
  assert.equal(
    resolveBackendHttpUrl("/api/session-image/codex/s1/0/%2Fa?x=1", true, location, 4319, token),
    "http://127.0.0.1:4319/api/session-image/codex/s1/0/%2Fa?x=1&session=abc.def_GHI",
  );
  assert.equal(
    resolveBackendHttpUrl("/api/chat-attachment/c1/a1", false, location, undefined, token),
    "https://manager.example.ts.net/api/chat-attachment/c1/a1?session=abc.def_GHI",
  );
  // 쿼리 값에 든 `?`는 쿼리의 일부다 — 첫 `?` 뒤를 통째로 보존한다.
  assert.equal(
    resolveBackendWebSocketUrl("/api/chat?q=a?b", false, location, undefined, token),
    "wss://manager.example.ts.net/api/chat?q=a%3Fb&session=abc.def_GHI",
  );
  // 토큰이 없으면 아무것도 붙지 않는다.
  assert.equal(
    resolveBackendWebSocketUrl("/api/terminal", false, location),
    "wss://manager.example.ts.net/api/terminal",
  );
});
