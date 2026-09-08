import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSpeechTranscript,
  isReadableFinalResponse,
  normalizeSpeechTranscript,
  speechRecognitionErrorText,
  speechTextFromMarkdown,
  splitSpeechText,
  voiceStatusText,
} from "./voice.ts";

test("transcript normalization preserves an existing editable draft", () => {
  assert.equal(normalizeSpeechTranscript("  음성\n 입력   문장 "), "음성 입력 문장");
  assert.equal(mergeSpeechTranscript("기존 초안", " 음성 입력 "), "기존 초안 음성 입력");
  assert.equal(mergeSpeechTranscript("기존 초안\n", " 음성 입력 "), "기존 초안\n음성 입력");
});

test("voice errors and states come as Korean/English pairs the component picks by locale", () => {
  const recognitionErrors = {
    "not-allowed": "마이크 권한이 거부되었습니다. 브라우저 또는 앱 설정에서 마이크 접근을 허용해 주세요.",
    "service-not-allowed": "마이크 권한이 거부되었습니다. 브라우저 또는 앱 설정에서 마이크 접근을 허용해 주세요.",
    "audio-capture": "사용할 수 있는 마이크를 찾지 못했습니다. 장치 연결과 입력 설정을 확인해 주세요.",
    "no-speech": "음성이 감지되지 않았습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.",
    network: "음성 전사 서비스에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.",
    "language-not-supported": "현재 언어는 이 환경의 음성 전사에서 지원되지 않습니다.",
    aborted: "음성 입력이 취소되었습니다.",
  };
  for (const [code, message] of Object.entries(recognitionErrors)) {
    const pair = speechRecognitionErrorText(code);
    assert.equal(pair.ko, message);
    // 영어 짝은 비어 있지 않고 한글이 섞이지 않는다.
    assert.ok(pair.en.length > 0);
    assert.doesNotMatch(pair.en, /[가-힣]/);
  }
  assert.equal(speechRecognitionErrorText("unknown").ko, "음성을 전사하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  assert.equal(speechRecognitionErrorText("not-allowed").en, "Microphone access was denied. Allow microphone access in your browser or app settings.");

  const statuses = {
    idle: "음성 입력",
    recording: "녹음 중 · 다시 누르면 전사를 시작합니다",
    transcribing: "전사 중…",
    ready: "전사 완료 · 문장을 확인·수정한 뒤 전송하세요",
    playing: "답변 재생 중 · 정지는 오디오만 멈춥니다",
  };
  for (const [status, message] of Object.entries(statuses)) {
    const pair = voiceStatusText(status);
    assert.equal(pair.ko, message);
    assert.doesNotMatch(pair.en, /[가-힣]/);
  }
  assert.equal(voiceStatusText("idle").en, "Voice input");
  assert.deepEqual(voiceStatusText("error"), { ko: "음성 기능을 사용할 수 없습니다.", en: "Voice features are unavailable." });
  assert.deepEqual(voiceStatusText("error", { ko: "사용자 오류", en: "user error" }), { ko: "사용자 오류", en: "user error" });
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

test("chunk boundaries prefer a late sentence end and fall back to spaces", () => {
  assert.deepEqual(splitSpeechText("", 10), []);
  // 문장 끝이 상한의 45%보다 앞이면 조각이 너무 짧아지므로 따르지 않고 마지막 공백에서 끊는다.
  assert.deepEqual(splitSpeechText("ab. cdefgh ijklmnop", 12), ["ab. cdefgh", "ijklmnop"]);
  // 문장 끝이 충분히 뒤면 종결 부호까지 담아 끊는다.
  assert.deepEqual(splitSpeechText("abcdefgh. ijklmnop", 12), ["abcdefgh.", "ijklmnop"]);
  // 공백도 종결 부호도 없는 덩이는 상한에서 그대로 자른다.
  assert.deepEqual(splitSpeechText("abcdefghijklmno", 10), ["abcdefghij", "klmno"]);
});
