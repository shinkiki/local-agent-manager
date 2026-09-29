import assert from "node:assert/strict";
import test from "node:test";

import {
  accountLabelDraftState,
  ACCOUNT_LABEL_MAX_CHARS,
  normalizeAccountLabel,
  submitAccountLabel,
} from "./accountLabel.ts";
import { testAccountTextEditor } from "./accountTextDraftSuite.mjs";

test("a label draft collapses multiple spaces and trims before saving", () => {
  assert.equal(normalizeAccountLabel("  메인   업무 계정  "), "메인 업무 계정");
  assert.equal(normalizeAccountLabel("첫 줄\n둘째 줄"), "첫 줄 둘째 줄");
  assert.equal(normalizeAccountLabel("변경 없음"), "변경 없음");
});

test("an empty draft means resetting the custom label", () => {
  for (const draft of ["", "   ", "\n\n", "\r\n"]) {
    assert.equal(normalizeAccountLabel(draft), null, JSON.stringify(draft));
  }
});

testAccountTextEditor({
  editor: "계정 표시 이름",
  draftState: accountLabelDraftState,
  submit: submitAccountLabel,
  maxChars: ACCOUNT_LABEL_MAX_CHARS,
  clearFlag: "restores",
  saved: "기존 별칭",
  savedRespaced: "  기존   별칭  ",
  fresh: "새 별칭",
  messyDraft: "  개발   팀  ",
  normalizedDraft: "개발 팀",
  saveError: "계정 표시 이름은 60자까지 저장할 수 있습니다",
  lengthSamples: [["🙂", 1], ["  🙂  🙂  ", 3], ["가나다", 3], ["   ", 0]],
});
