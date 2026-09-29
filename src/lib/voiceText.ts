/**
 * 음성 기능이 화면에 내놓는 문구 — 상태 한 줄과 인식 오류 코드별 안내.
 *
 * 능력 탐지(`speechRecognition`)와는 서로 읽을 것이 없다. 저쪽은 지금 실행이 음성 인식·합성을
 * 가졌는지 `window`에 묻는 일이고, 여기는 이미 정해진 상태·오류 코드 하나를 한국어·영어
 * 짝으로 바꾸는 순수한 표다. 답이 달라지는 이유도 겹치지 않는다 — 저쪽은 브라우저가 노출하는
 * 전역 이름이, 여기는 문구와 로케일이 바뀔 때 달라진다.
 *
 * 한 파일에 두면 안내 문장을 한 줄 고치러 온 사람이 `SpeechRecognition` 타입 선언과 전역
 * 탐색을 함께 읽고, 반대로 웹킷 접두 하나를 더 보게 하려고 들어온 사람이 문구 표 일곱 개를
 * 지나쳐야 한다. 낭독 글 만들기를 `speechText`로 가른 것과 같은 요령이다.
 */

/**
 * 한국어·영어 짝에서 지금 로케일의 문구를 고르는 컴포넌트의 `text`. 스킬관리 lib이 쓰는
 * `skillLocaleText.Translate`와 모양은 같지만, 그 파일은 스킬관리 모듈들이 함께 쓰려고 둔
 * 어휘라 음성 쪽이 빌려 쓰면 두 갈래 사이에 방향 없는 의존이 생긴다.
 */
type Translate = (ko: string, en: string) => string;

export type VoiceStatus = "idle" | "recording" | "transcribing" | "ready" | "playing" | "error";

/**
 * 음성 문구 한 벌. 이 모듈은 React 바깥의 평범한 모듈이라 언어 문맥을 모른다. 그래서 문구를
 * 바로 만들지 않고, 지금 언어를 고르는 손잡이(`useI18n().text`)를 받아 만드는 함수로 들고
 * 다닌다 — 짝을 `{ ko, en }` 자료로만 적어 두면 `text(ko, en)` 호출만 읽는 생성 번역
 * 카탈로그가 이 짝을 소스에서 거두지 못한다.
 */
export type VoiceText = (text: Translate) => string;

/** 권한 거부는 브라우저가 두 코드로 알린다. 사용자가 할 일은 같으므로 문구도 한 벌만 둔다. */
const MICROPHONE_DENIED_TEXT: VoiceText = (text) => text(
  "마이크 권한이 거부되었습니다. 브라우저 또는 앱 설정에서 마이크 접근을 허용해 주세요.",
  "Microphone access was denied. Allow microphone access in your browser or app settings.",
);

const SPEECH_RECOGNITION_ERROR_TEXTS: Readonly<Record<string, VoiceText>> = {
  "not-allowed": MICROPHONE_DENIED_TEXT,
  "service-not-allowed": MICROPHONE_DENIED_TEXT,
  "audio-capture": (text) => text(
    "사용할 수 있는 마이크를 찾지 못했습니다. 장치 연결과 입력 설정을 확인해 주세요.",
    "No usable microphone was found. Check the device connection and input settings.",
  ),
  "no-speech": (text) => text(
    "음성이 감지되지 않았습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.",
    "No speech was detected. Speak closer to the microphone and try again.",
  ),
  network: (text) => text(
    "음성 전사 서비스에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.",
    "Could not reach the speech transcription service. Check your network connection.",
  ),
  "language-not-supported": (text) => text(
    "현재 언어는 이 환경의 음성 전사에서 지원되지 않습니다.",
    "The current language is not supported by speech transcription in this environment.",
  ),
  aborted: (text) => text("음성 입력이 취소되었습니다.", "Voice input was cancelled."),
};

const UNKNOWN_SPEECH_RECOGNITION_ERROR_TEXT: VoiceText = (text) => text(
  "음성을 전사하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  "Speech could not be transcribed. Try again in a moment.",
);

const VOICE_UNAVAILABLE_TEXT: VoiceText = (text) => text("음성 기능을 사용할 수 없습니다.", "Voice features are unavailable.");

const VOICE_STATUS_TEXTS: Record<Exclude<VoiceStatus, "error">, VoiceText> = {
  idle: (text) => text("음성 입력", "Voice input"),
  recording: (text) => text("녹음 중 · 다시 누르면 전사를 시작합니다", "Recording · press again to transcribe"),
  transcribing: (text) => text("전사 중…", "Transcribing…"),
  ready: (text) => text("전사 완료 · 문장을 확인·수정한 뒤 전송하세요", "Transcribed · review and edit the text before sending"),
  playing: (text) => text("답변 재생 중 · 정지는 오디오만 멈춥니다", "Playing the response · stop only halts the audio"),
};

export function speechRecognitionErrorText(code: string): VoiceText {
  return SPEECH_RECOGNITION_ERROR_TEXTS[code] ?? UNKNOWN_SPEECH_RECOGNITION_ERROR_TEXT;
}

export function voiceStatusText(status: VoiceStatus, error: VoiceText | null = null): VoiceText {
  if (status === "error") return error ?? VOICE_UNAVAILABLE_TEXT;
  return VOICE_STATUS_TEXTS[status];
}
