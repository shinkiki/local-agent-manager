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
