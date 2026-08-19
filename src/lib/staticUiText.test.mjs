import assert from "node:assert/strict";
import test from "node:test";
import { canonicalSourceText } from "./staticUiText.ts";

const staticKoreanByEnglish = new Map([
  ["", "개"],
  ["Permission mode", "권한 모드"],
]);

test("whitespace-only React nodes are not reverse-translated to a unit label", () => {
  assert.equal(canonicalSourceText(" ", {}, staticKoreanByEnglish, new Map()), " ");
});

test("non-empty translated text still resolves to its Korean source", () => {
  assert.equal(
    canonicalSourceText(" Permission mode ", {}, staticKoreanByEnglish, new Map()),
    " 권한 모드 ",
  );
});
