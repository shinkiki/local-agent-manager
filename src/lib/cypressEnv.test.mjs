import assert from "node:assert/strict";
import test from "node:test";

import { parseEnvJsonText } from "./cypressEnv.ts";

test("parseEnvJsonText accepts flat objects and returns Error otherwise", () => {
  assert.deepEqual(parseEnvJsonText(""), {});
  assert.deepEqual(parseEnvJsonText("   \n"), {});
  assert.deepEqual(parseEnvJsonText('{"BASE_URL": "https://example.com", "RETRIES": 2, "HEADLESS": true}'), {
    BASE_URL: "https://example.com",
    RETRIES: "2",
    HEADLESS: "true",
  });
  assert.ok(parseEnvJsonText("{ not json") instanceof Error);
  assert.ok(parseEnvJsonText("[1, 2]") instanceof Error);
  assert.ok(parseEnvJsonText("null") instanceof Error);
  assert.ok(parseEnvJsonText('"text"') instanceof Error);
  const nested = parseEnvJsonText('{"A": {"b": 1}}');
  assert.ok(nested instanceof Error);
  assert.match(nested.message, /'A'/);
});
