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

/**
 * 전사를 지원하지 않는 환경에서 버튼 설명과 상태 문구가 함께 쓰는 안내. 두 자리에
 * 손으로 적어 두면 한쪽만 고쳐져 같은 상황을 두 문장으로 알리게 된다.
 */
export const RECOGNITION_UNSUPPORTED_TEXT: VoiceText = (text) => text(
  "이 브라우저 또는 WebView는 음성 전사를 지원하지 않습니다. 텍스트 입력을 사용해 주세요.",
  "This browser or WebView does not support speech transcription. Use text input instead.",
);

/** 버튼 상태를 고를 때 읽는 답변 재생 쪽 사정. 재생 상태 전체가 아니라 이 판정에 필요한 부분만. */
export interface VoicePlaybackState {
  status: "idle" | "playing" | "error";
  error: VoiceText | null;
}

/**
 * 마이크 버튼 한 짝이 보여 줄 상태와 그때의 오류. 마이크 입력과 답변 재생은 서로 다른
 * 상태를 들고 있지만 버튼과 상태 문구는 하나뿐이라, 둘 중 무엇을 보일지 고르는 우선순위가
 * 필요하다.
 *
 * 예전에는 그 우선순위를 상태 한 벌, 오류 한 벌로 따로 풀었다. 두 사다리는 가지가 서로
 * 달라(상태는 재생 중·미지원·재생 실패 순, 오류는 입력 실패·미지원·재생 실패 순) 같은
 * 판정을 두 모양으로 적어 둔 셈이었고, 한쪽에 갈래를 더하면 다른 쪽이 조용히 어긋난다 —
 * 이를테면 상태만 error로 올리고 오류를 빠뜨리면 "음성을 쓸 수 없습니다"라는 기본 문구가
 * 대신 나가 무엇이 막혔는지 알 수 없게 된다.
 *
 * 그래서 갈래마다 상태와 오류를 한 번에 짝지어 돌려준다. 오류 문구는 상태가 error일 때만
 * 화면에 닿으므로(`voiceStatusText`), 나머지 갈래는 null로 둔다. 컴포넌트 파일 안에
 * 있던 동안에는 이 우선순위를 붙잡는 시험이 설 자리가 없어 여기로 옮겼다.
 */
export function voiceButtonState(
  inputStatus: Exclude<VoiceStatus, "playing">,
  inputError: VoiceText | null,
  playback: VoicePlaybackState,
  recognitionSupported: boolean,
): { status: VoiceStatus; error: VoiceText | null } {
  // 재생 중은 다른 무엇보다 먼저다. 이 버튼이 그때 하는 일(누르면 녹음이 재생을 끊는다)이
  // 다른 상태와 다르기 때문이다.
  if (playback.status === "playing") return { status: "playing", error: null };
  // 내 입력이 진행·실패 중이면 그것이 사용자가 방금 한 일이므로 재생 쪽 사정보다 앞선다.
  if (inputStatus === "error") return { status: "error", error: inputError };
  if (inputStatus !== "idle") return { status: inputStatus, error: null };
  // 아무것도 하지 않는 동안에만 환경 제약과 지난 재생 실패가 드러난다.
  if (!recognitionSupported) return { status: "error", error: RECOGNITION_UNSUPPORTED_TEXT };
  if (playback.status === "error") return { status: "error", error: playback.error };
  return { status: "idle", error: null };
}
