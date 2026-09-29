import assert from "node:assert/strict";
import { test } from "node:test";

import {
  catalogForLocalConnection,
  localConnectionIdForRequest,
  localConnectionLabel,
  selectedLocalConnection,
} from "./localConnections.ts";

const text = (ko) => ko;
const model = (name) => ({ model: name, displayName: name, description: "", isDefault: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] });
const connection = (id, extra = {}) => ({
  id, label: id.toUpperCase(), isDefault: false, enabled: true, baseUrl: `http://${id}/v1`, defaultModel: "a", models: [model(`${id}-a`)], catalogError: null, ...extra,
});
const catalog = {
  source: "local",
  models: [model("default-a")],
  localConnections: [connection("default", { isDefault: true }), connection("macbook", { catalogError: "닿지 않음", models: [] })],
  supportedReasoningEfforts: [], defaultReasoningEffort: null, catalogError: null, settings: [], settingsUpdatedAt: null, catalogUpdatedAt: null, cliVersion: null, catalogStale: false,
};

// M7 7.4: 빈 id 는 기본 연결, 없는 id 는 null, 고른 연결의 목록으로 카탈로그가 바뀐다.
test("연결을 고르면 그 연결의 모델 목록과 오류가 카탈로그에 실린다", () => {
  assert.equal(selectedLocalConnection(catalog, "").id, "default");
  assert.equal(selectedLocalConnection(catalog, "macbook").id, "macbook");
  assert.equal(selectedLocalConnection(catalog, "nope"), null);
  assert.equal(selectedLocalConnection({ ...catalog, localConnections: [] }, "default"), null);

  const picked = catalogForLocalConnection(catalog, "macbook");
  assert.deepEqual(picked.models, []);
  assert.equal(picked.catalogError, "닿지 않음");
  // 지워진 연결 id 는 기본 연결 목록으로 돌아간다 — 빈 목록은 서버가 죽은 것처럼 보인다.
  assert.equal(catalogForLocalConnection(catalog, "gone").models[0].model, "default-a");
  // 연결 목록이 없는 공급자는 그대로다.
  const codex = { ...catalog, source: "codex", localConnections: undefined };
  assert.equal(catalogForLocalConnection(codex, "x"), codex);
  assert.equal(catalogForLocalConnection(null, "x"), null);
});

test("표시 이름은 기본·꺼짐을 붙이고 요청값은 로컬 공급자에서만 실린다", () => {
  assert.equal(localConnectionLabel(connection("a", { isDefault: true }), text), "A (기본)");
  assert.equal(localConnectionLabel(connection("a", { enabled: false }), text), "A (꺼짐)");
  assert.equal(localConnectionLabel(connection("a"), text), "A");
  assert.equal(localConnectionIdForRequest("local", " macbook "), "macbook");
  assert.equal(localConnectionIdForRequest("local", ""), null);
  assert.equal(localConnectionIdForRequest("codex", "macbook"), null);
});
