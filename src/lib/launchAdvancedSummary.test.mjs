import assert from "node:assert/strict";
import { test } from "node:test";

import { launchAdvancedSummary } from "./launchAdvancedSummary.ts";

const fields = [{ key: "fallbackModel", label: "예비 모델" }, { key: "profile", label: "프로필" }];

test("고른 값이 없으면 항목 이름 뒤에 기본값을 붙인다", () => {
  assert.equal(launchAdvancedSummary(fields, {}), "예비 모델 · 프로필 기본값");
});

test("공백만 든 값은 고르지 않은 것으로 본다", () => {
  assert.equal(launchAdvancedSummary(fields, { fallbackModel: "   " }), "예비 모델 · 프로필 기본값");
});

test("값이 있는 항목만 순서대로 잇고 앞뒤 공백은 떼어 보인다", () => {
  assert.equal(launchAdvancedSummary(fields, { profile: " work ", fallbackModel: "" }), "프로필 work");
  assert.equal(launchAdvancedSummary(fields, { fallbackModel: "m1", profile: "p" }), "예비 모델 m1 · 프로필 p");
});
