import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSpeechTranscript,
  isReadableFinalResponse,
  normalizeSpeechTranscript,
  speechRecognitionErrorText,
  voiceStatusText,
} from "./voice.ts";

test("transcript normalization preserves an existing editable draft", () => {
  assert.equal(normalizeSpeechTranscript("  음성\n 입력   문장 "), "음성 입력 문장");
  assert.equal(mergeSpeechTranscript("기존 초안", " 음성 입력 "), "기존 초안 음성 입력");
  assert.equal(mergeSpeechTranscript("기존 초안\n", " 음성 입력 "), "기존 초안\n음성 입력");
});

test("voice errors and states come as Korean/English pairs the component picks by locale", () => {
  // 문구는 언어 손잡이를 받는 함수다. 두 손잡이로 같은 항목을 불러 양쪽 표기를 함께 읽는다.
  const ko = (korean) => korean;
  const en = (_korean, english) => english;

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
    const spec = speechRecognitionErrorText(code);
    assert.equal(spec(ko), message);
    // 영어 짝은 비어 있지 않고 한글이 섞이지 않는다.
    assert.ok(spec(en).length > 0);
    assert.doesNotMatch(spec(en), /[가-힣]/);
  }
  assert.equal(speechRecognitionErrorText("unknown")(ko), "음성을 전사하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  assert.equal(speechRecognitionErrorText("not-allowed")(en), "Microphone access was denied. Allow microphone access in your browser or app settings.");

  const statuses = {
    idle: "음성 입력",
    recording: "녹음 중 · 다시 누르면 전사를 시작합니다",
    transcribing: "전사 중…",
    ready: "전사 완료 · 문장을 확인·수정한 뒤 전송하세요",
    playing: "답변 재생 중 · 정지는 오디오만 멈춥니다",
  };
  for (const [status, message] of Object.entries(statuses)) {
    const spec = voiceStatusText(status);
    assert.equal(spec(ko), message);
    assert.doesNotMatch(spec(en), /[가-힣]/);
  }
  assert.equal(voiceStatusText("idle")(en), "Voice input");
  assert.equal(voiceStatusText("error")(ko), "음성 기능을 사용할 수 없습니다.");
  assert.equal(voiceStatusText("error")(en), "Voice features are unavailable.");
  // 넘긴 오류 문구가 있으면 기본 문구 대신 그것이 쓰인다.
  const userError = (text) => text("사용자 오류", "user error");
  assert.equal(voiceStatusText("error", userError)(ko), "사용자 오류");
  assert.equal(voiceStatusText("error", userError)(en), "user error");
});

test("only the last assistant message of a completed turn is readable", () => {
  assert.equal(isReadableFinalResponse("completed", true), true);
  assert.equal(isReadableFinalResponse("completedWithDenials", true), true);
  assert.equal(isReadableFinalResponse("completed", false), false);
  assert.equal(isReadableFinalResponse("interrupted", true), false);
  assert.equal(isReadableFinalResponse("failed", true), false);
});
