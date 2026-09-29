import assert from "node:assert/strict";
import test from "node:test";
import { clampPreviewText } from "./aiaPreviewText.ts";

test("빈 문구와 공백만 있는 문구는 띄울 것이 없다", () => {
  assert.equal(clampPreviewText(null, 10), null);
  assert.equal(clampPreviewText(undefined, 10), null);
  assert.equal(clampPreviewText("   \n\t ", 10), null);
});

test("줄바꿈과 연속 공백은 한 칸으로 접고 상한 안이면 그대로 둔다", () => {
  assert.equal(clampPreviewText(" 첫 줄\n\n  둘째   줄 ", 40), "첫 줄 둘째 줄");
});

test("경계가 없는 긴 문구는 상한에서 끊고 말줄임표를 붙인다", () => {
  const clamped = clampPreviewText("가".repeat(40), 10);
  assert.equal([...clamped].length, 11);
  assert.ok(clamped.endsWith("…"));
});

test("허용 구간 안의 마지막 문장 끝에서 마무리한다", () => {
  assert.equal(clampPreviewText("세션을 확인했습니다. 남은 작업은 없습니다.", 14), "세션을 확인했습니다.…");
});

test("문장 끝이 없으면 마지막 낱말 경계에서 끊는다", () => {
  assert.equal(clampPreviewText("확인한세션 확인한세션 확인한세션", 13), "확인한세션 확인한세션…");
});

test("뒤가 공백이 아닌 점은 문장 끝으로 보지 않는다", () => {
  // `1.5`의 점을 문장 끝으로 읽었다면 "이번 측정 값은 1.…"에서 끊겼을 자리다.
  assert.equal(clampPreviewText("이번 측정 값은 1.5였고 나머지는 그대로다", 15), "이번 측정 값은 1.5였고…");
});
