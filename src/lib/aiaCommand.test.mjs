import assert from "node:assert/strict";
import test from "node:test";

import { aiaCommandText, MAX_AIA_COMMAND_CHARS } from "./aiaCommand.ts";

test("AIA command blocks become trimmed drafts within the limit", () => {
  assert.equal(aiaCommandText("  다음 작업을 확인해줘.\n"), "다음 작업을 확인해줘.");
  assert.equal(aiaCommandText("   \n"), null);
  assert.equal(aiaCommandText("가".repeat(MAX_AIA_COMMAND_CHARS + 1)), null);
});
