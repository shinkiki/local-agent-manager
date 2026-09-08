import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUiOpener,
  matchUiElementLocator,
  normalizeUiText,
  rankUiElements,
  scoreUiElement,
  uiClickRefusal,
  uiRefSelector,
} from "./uiElements.ts";

const candidates = [
  { ref: "r-save", role: "button", text: "저장", anchor: null },
  { ref: "r-save-close", role: "button", text: "저장 후 닫기", anchor: null },
  { ref: "r-cancel", role: "button", text: "취소", anchor: null },
  { ref: "r-path", role: "textbox", text: "저장소 경로", anchor: "settings.repository-path" },
  { ref: "r-tab", role: "tab", text: "저장소", anchor: "settings.tab.repository" },
];

test("scores exact text highest, then containment, then role words", () => {
  assert.equal(scoreUiElement(candidates[0], "저장"), 5);
  assert.equal(scoreUiElement(candidates[1], "저장"), 3);
  assert.equal(scoreUiElement(candidates[2], "저장"), 0);
  assert.equal(scoreUiElement(candidates[2], "취소 버튼"), 5 + 1, "'버튼'은 role button과 맞아 1점을 더한다");
  assert.equal(scoreUiElement(candidates[3], "경로 입력"), 3 + 1);
  assert.equal(scoreUiElement(candidates[0], ""), 1, "빈 query는 모두 1점이라 목록 전체가 나온다");
});

test("ranks by score, then by shorter text, and honours the limit", () => {
  const ranked = rankUiElements(candidates, "저장");
  assert.deepEqual(ranked.map((item) => item.ref), ["r-save", "r-tab", "r-path", "r-save-close"]);
  assert.deepEqual(rankUiElements(candidates, "저장", 2).map((item) => item.ref), ["r-save", "r-tab"]);
  assert.deepEqual(rankUiElements(candidates, "없는 것"), []);
});

test("locators resolve by ref first, then exact text, then a good enough fuzzy match", () => {
  assert.equal(matchUiElementLocator(candidates, { ref: "r-cancel" })?.ref, "r-cancel");
  assert.equal(matchUiElementLocator(candidates, { ref: "gone", text: "저장" })?.ref, "r-save", "ref가 사라지면 텍스트로 되찾는다");
  assert.equal(matchUiElementLocator(candidates, { text: "저장소", role: "textbox" })?.ref, "r-path", "역할이 주어지면 그 역할 안에서만 찾는다");
  assert.equal(matchUiElementLocator(candidates, { text: "저장소 경로 입력" })?.ref, "r-path");
  assert.equal(matchUiElementLocator(candidates, { text: "삭제" }), null);
  assert.equal(matchUiElementLocator(candidates, { ref: "gone" }), null, "텍스트 단서가 없으면 추측하지 않는다");
});

function fakeElement({ tag = "button", attrs = {}, ancestors = [], disabled = false } = {}) {
  return {
    tagName: tag.toUpperCase(),
    disabled,
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
    closest: (selector) => (selector.split(",").some((part) => ancestors.includes(part.trim())) ? {} : null),
  };
}

test("only opening controls may be clicked without approval", () => {
  assert.equal(isUiOpener(fakeElement({ attrs: { "data-ui-anchor": "nav.settings" } })), true);
  assert.equal(isUiOpener(fakeElement({ attrs: { role: "tab" } })), true);
  assert.equal(isUiOpener(fakeElement({ attrs: { "aria-expanded": "false" } })), true);
  assert.equal(isUiOpener(fakeElement({ attrs: { "aria-haspopup": "dialog" } })), true);
  assert.equal(isUiOpener(fakeElement({ tag: "summary" })), true);
  assert.equal(isUiOpener(fakeElement({ ancestors: ["nav"] })), true);
  assert.equal(isUiOpener(fakeElement()), false, "표식 없는 일반 버튼은 여는 동작이 아니다");

  assert.equal(uiClickRefusal(fakeElement({ attrs: { role: "tab" } }), "open"), null);
  assert.match(uiClickRefusal(fakeElement(), "open"), /click_ui_element/);
  assert.equal(uiClickRefusal(fakeElement(), "click"), null, "승인 경로에서는 일반 버튼도 누른다");
  assert.match(uiClickRefusal(fakeElement({ ancestors: [".modal-backdrop"] }), "click"), /확인 모달/);
  assert.match(uiClickRefusal(fakeElement({ ancestors: [".aia-chat-popup"] }), "click"), /AIA 팝업/);
  assert.match(uiClickRefusal(fakeElement({ disabled: true, attrs: { role: "tab" } }), "open"), /비활성화/);
});

test("text normalization collapses whitespace and caps length", () => {
  assert.equal(normalizeUiText("  저장\n  후   닫기 "), "저장 후 닫기");
  assert.equal(normalizeUiText("a".repeat(80)).length, 60);
  assert.equal(uiRefSelector('r"1'), '[data-ui-ref="r\\"1"]');
});
