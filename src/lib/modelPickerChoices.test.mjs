import assert from "node:assert/strict";
import { test } from "node:test";

import { modelPickerChoices } from "./modelPickerChoices.ts";

const text = (ko) => ko;
const model = (name, extra = {}) => ({ model: name, displayName: name.toUpperCase(), description: "카탈로그", isDefault: false, defaultReasoningEffort: null, supportedReasoningEfforts: [], ...extra });
const catalog = { models: [model("a", { isDefault: true }), model("b")] };

test("카탈로그 · 최근 · 저장값 순으로 합치고 먼저 담긴 설명을 남긴다", () => {
  const { options, countByModel } = modelPickerChoices(catalog, [{ model: "b", count: 3 }, { model: "r", count: 1 }], "saved", text);
  assert.deepEqual(options.map((option) => option.model), ["a", "b", "r", "saved"]);
  assert.equal(options[1].description, "카탈로그");
  assert.equal(options[2].description, "최근 세션에서 사용한 모델");
  assert.equal(options[3].description, "저장된 모델 식별자");
  assert.equal(options[3].displayName, "saved");
  assert.equal(countByModel.get("b"), 3);
});

test("값이 비면 카탈로그 기본 모델이, 값이 있으면 그 항목이 선택된다", () => {
  assert.equal(modelPickerChoices(catalog, [], "", text).selected?.model, "a");
  assert.equal(modelPickerChoices(catalog, [], "b", text).selected?.model, "b");
  assert.equal(modelPickerChoices(catalog, [], "saved", text).selected?.description, "저장된 모델 식별자");
  assert.equal(modelPickerChoices(catalog, [{ model: "b", count: 1 }], "b", text).options.length, 2);
});

test("카탈로그가 없어도 최근 · 저장값으로 목록을 만든다", () => {
  const { options, selected } = modelPickerChoices(null, [{ model: "r", count: 2 }], "", text);
  assert.deepEqual(options.map((option) => option.model), ["r"]);
  assert.equal(selected, undefined);
});
