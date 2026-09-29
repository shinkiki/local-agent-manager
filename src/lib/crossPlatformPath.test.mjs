import assert from "node:assert/strict";
import test from "node:test";

import { cleanPathInput, normalizePathSlashes, pathFileName } from "./crossPlatformPath.ts";

test("normalizePathSlashes는 구분자만 맞추고 공백은 그대로 둔다", () => {
  assert.equal(normalizePathSlashes("src\\lib\\a.ts"), "src/lib/a.ts");
  assert.equal(normalizePathSlashes(" src/a.ts "), " src/a.ts ");
  assert.equal(normalizePathSlashes(""), "");
});

test("cleanPathInput은 다듬은 뒤 구분자를 맞춘다", () => {
  assert.equal(cleanPathInput("  cypress\\e2e\\a.cy.ts  "), "cypress/e2e/a.cy.ts");
  assert.equal(cleanPathInput("   "), "");
  assert.equal(cleanPathInput(""), "");
});

test("pathFileName은 마지막 조각을, 구분자가 없으면 전체를 돌려준다", () => {
  assert.equal(pathFileName("src\\lib\\a.ts"), "a.ts");
  assert.equal(pathFileName("a.ts"), "a.ts");
  assert.equal(pathFileName("src/lib/"), "");
  assert.equal(pathFileName(""), "");
});

test("다듬은 경로에서 이름을 뽑으면 앞뒤 공백이 이름에 섞이지 않는다", () => {
  assert.equal(pathFileName(cleanPathInput(" support\\cypress.env.json ")), "cypress.env.json");
  assert.equal(pathFileName(cleanPathInput("cypress.env.json")), "cypress.env.json");
  assert.equal(pathFileName(cleanPathInput(" e2e/ ")), "");
});
