import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSpeechTranscript,
  isReadableFinalResponse,
  normalizeSpeechTranscript,
  speechRecognitionErrorMessage,
  speechTextFromMarkdown,
  splitSpeechText,
  voiceStatusMessage,
} from "./voice.ts";

test("transcript normalization preserves an existing editable draft", () => {
  assert.equal(normalizeSpeechTranscript("  음성\n 입력   문장 "), "음성 입력 문장");
  assert.equal(mergeSpeechTranscript("기존 초안", " 음성 입력 "), "기존 초안 음성 입력");
  assert.equal(mergeSpeechTranscript("기존 초안\n", " 음성 입력 "), "기존 초안\n음성 입력");
});

test("voice errors and states use actionable Korean UI text", () => {
  assert.match(speechRecognitionErrorMessage("not-allowed"), /마이크 권한/);
  assert.match(speechRecognitionErrorMessage("no-speech"), /음성이 감지되지/);
  assert.match(voiceStatusMessage("ready"), /확인·수정/);
  assert.match(voiceStatusMessage("playing"), /오디오만/);
});

test("only the last assistant message of a completed turn is readable", () => {
  assert.equal(isReadableFinalResponse("completed", true), true);
  assert.equal(isReadableFinalResponse("completedWithDenials", true), true);
  assert.equal(isReadableFinalResponse("completed", false), false);
  assert.equal(isReadableFinalResponse("interrupted", true), false);
  assert.equal(isReadableFinalResponse("failed", true), false);
});

test("speech output strips markdown controls and is split into bounded chunks", () => {
  const plain = speechTextFromMarkdown("## 결과\n- **완료** [문서](https://example.com)\n```txt\n코드\n```");
  assert.equal(plain, "결과 완료 문서 코드");
  const chunks = splitSpeechText("첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.", 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
  assert.equal(chunks.join(" "), "첫 문장입니다. 두 번째 문장입니다. 세 번째 문장입니다.");
});
