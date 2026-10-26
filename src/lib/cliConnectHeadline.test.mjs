import assert from "node:assert/strict";
import test from "node:test";
import { cliConnectHeadline } from "./cliConnectHeadline.ts";

test("CLI가 있으면 기록 여부와 상관없이 found", () => {
  assert.equal(cliConnectHeadline(true, true), "found");
  assert.equal(cliConnectHeadline(true, false), "found");
});

test("CLI가 없을 때 기록이 있다고 말하는 것은 기록이 탐지됐을 때뿐이다", () => {
  assert.equal(cliConnectHeadline(false, true), "missingWithHistory");
  assert.equal(cliConnectHeadline(false, false), "missing");
});
