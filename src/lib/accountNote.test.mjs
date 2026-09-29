import assert from "node:assert/strict";
import test from "node:test";

import {
  accountNoteDraftState,
  ACCOUNT_NOTE_MAX_CHARS,
  normalizeAccountNote,
  submitAccountNote,
} from "./accountNote.ts";
import { testAccountTextEditor } from "./accountTextDraftSuite.mjs";

test("a note draft is trimmed and line endings are normalized before saving", () => {
  assert.equal(normalizeAccountNote("  결제 담당 계정  "), "결제 담당 계정");
  assert.equal(normalizeAccountNote("첫 줄\r\n둘째 줄"), "첫 줄\n둘째 줄");
  assert.equal(normalizeAccountNote("변경 없음"), "변경 없음");
});

test("an empty draft means deleting the stored note", () => {
  for (const draft of ["", "   ", "\n\n", "\r\n"]) {
    assert.equal(normalizeAccountNote(draft), null, JSON.stringify(draft));
  }
});

testAccountTextEditor({
  editor: "계정 메모",
  draftState: accountNoteDraftState,
  submit: submitAccountNote,
  maxChars: ACCOUNT_NOTE_MAX_CHARS,
  clearFlag: "removes",
  saved: "기존 메모",
  savedRespaced: "  기존 메모  ",
  fresh: "새 메모",
  messyDraft: "  결제 담당\r\n계정  ",
  normalizedDraft: "결제 담당\n계정",
  saveError: "계정 메모는 500자까지 저장할 수 있습니다",
  lengthSamples: [["🙂", 1], ["  🙂🙂  ", 2], ["가나다", 3]],
});
