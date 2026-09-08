export type VoiceStatus = "idle" | "recording" | "transcribing" | "ready" | "playing" | "error";

/**
 * 음성 문구 한 벌. 이 모듈은 React 바깥의 평범한 모듈이라 언어 문맥을 모른다. 문구는
 * 한국어·영어 짝으로 내보내고, 어느 쪽을 그릴지는 컴포넌트가 useI18n().text로 고른다.
 */
export interface VoiceText {
  ko: string;
  en: string;
}

/** 권한 거부는 브라우저가 두 코드로 알린다. 사용자가 할 일은 같으므로 문구도 한 벌만 둔다. */
const MICROPHONE_DENIED_TEXT: VoiceText = {
  ko: "마이크 권한이 거부되었습니다. 브라우저 또는 앱 설정에서 마이크 접근을 허용해 주세요.",
  en: "Microphone access was denied. Allow microphone access in your browser or app settings.",
};

const SPEECH_RECOGNITION_ERROR_TEXTS: Readonly<Record<string, VoiceText>> = {
  "not-allowed": MICROPHONE_DENIED_TEXT,
  "service-not-allowed": MICROPHONE_DENIED_TEXT,
  "audio-capture": {
    ko: "사용할 수 있는 마이크를 찾지 못했습니다. 장치 연결과 입력 설정을 확인해 주세요.",
    en: "No usable microphone was found. Check the device connection and input settings.",
  },
  "no-speech": {
    ko: "음성이 감지되지 않았습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.",
    en: "No speech was detected. Speak closer to the microphone and try again.",
  },
  network: {
    ko: "음성 전사 서비스에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.",
    en: "Could not reach the speech transcription service. Check your network connection.",
  },
  "language-not-supported": {
    ko: "현재 언어는 이 환경의 음성 전사에서 지원되지 않습니다.",
    en: "The current language is not supported by speech transcription in this environment.",
  },
  aborted: { ko: "음성 입력이 취소되었습니다.", en: "Voice input was cancelled." },
};

const UNKNOWN_SPEECH_RECOGNITION_ERROR_TEXT: VoiceText = {
  ko: "음성을 전사하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  en: "Speech could not be transcribed. Try again in a moment.",
};

const VOICE_UNAVAILABLE_TEXT: VoiceText = { ko: "음성 기능을 사용할 수 없습니다.", en: "Voice features are unavailable." };

const VOICE_STATUS_TEXTS = {
  idle: { ko: "음성 입력", en: "Voice input" },
  recording: { ko: "녹음 중 · 다시 누르면 전사를 시작합니다", en: "Recording · press again to transcribe" },
  transcribing: { ko: "전사 중…", en: "Transcribing…" },
  ready: { ko: "전사 완료 · 문장을 확인·수정한 뒤 전송하세요", en: "Transcribed · review and edit the text before sending" },
  playing: { ko: "답변 재생 중 · 정지는 오디오만 멈춥니다", en: "Playing the response · stop only halts the audio" },
} as const satisfies Record<Exclude<VoiceStatus, "error">, VoiceText>;

export interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

export interface SpeechRecognitionEventLike extends Event {
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

export interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

export function speechPlaybackSupported(): boolean {
  return typeof window !== "undefined"
    && "speechSynthesis" in window
    && "SpeechSynthesisUtterance" in window;
}

export function normalizeSpeechTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function mergeSpeechTranscript(draft: string, transcript: string): string {
  const normalized = normalizeSpeechTranscript(transcript);
  if (!normalized) return draft;
  if (!draft) return normalized;
  if (/\s$/.test(draft)) return `${draft}${normalized}`;
  return `${draft} ${normalized}`;
}

export function speechRecognitionErrorText(code: string): VoiceText {
  return SPEECH_RECOGNITION_ERROR_TEXTS[code] ?? UNKNOWN_SPEECH_RECOGNITION_ERROR_TEXT;
}

export function voiceStatusText(status: VoiceStatus, error: VoiceText | null = null): VoiceText {
  if (status === "error") return error ?? VOICE_UNAVAILABLE_TEXT;
  return VOICE_STATUS_TEXTS[status];
}

export function isReadableFinalResponse(turnStatus: string, isLastAssistantMessage: boolean): boolean {
  return isLastAssistantMessage && (turnStatus === "completed" || turnStatus === "completedWithDenials");
}

export function speechTextFromMarkdown(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[|*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 문장이 끝났다고 볼 표기. 마지막 글자까지 포함해 끊으므로 종결 부호를 그대로 둔다.
 *
 * 한국어 종결어미를 함께 잡는 후보("다. ")는 두지 않는다 — 같은 자리를 ". "가 한 칸
 * 뒤에서 잡아 언제나 그쪽이 더 뒤이므로, 후보로 남겨 두어도 한 번도 뽑히지 않는다.
 */
const SPEECH_SENTENCE_BREAKS = [". ", "! ", "? ", "。"] as const;

/**
 * 문장 끝을 조각 경계로 채택하는 최소 위치(상한 대비 비율). 이보다 앞에서 끝난 문장을
 * 따르면 조각 하나가 지나치게 짧아져 재생이 자주 끊긴다.
 */
const SPEECH_SENTENCE_BREAK_RATIO = 0.45;

/**
 * 남은 글에서 조각 하나를 어디까지 가져갈지. 상한 안의 마지막 문장 끝을 먼저 보고,
 * 그 자리가 너무 앞이면 마지막 공백에서, 공백조차 없는 긴 덩이면 상한에서 그대로 자른다.
 *
 * 세 갈래가 정하는 것은 끊는 위치 하나뿐이라 판정만 여기 두고, 잘라 담는 일은 호출부가 한다.
 */
function speechChunkEnd(remaining: string, maximumLength: number): number {
  // 상한 바로 다음 글자까지 본다. 종결 부호가 상한에 걸쳐 있어도 그 자리를 놓치지 않는다.
  const windowText = remaining.slice(0, maximumLength + 1);
  const sentenceEnd = Math.max(...SPEECH_SENTENCE_BREAKS.map((mark) => windowText.lastIndexOf(mark)));
  if (sentenceEnd >= Math.floor(maximumLength * SPEECH_SENTENCE_BREAK_RATIO)) return sentenceEnd + 1;
  const whitespace = windowText.lastIndexOf(" ");
  return whitespace > 0 ? whitespace : maximumLength;
}

export function splitSpeechText(text: string, maximumLength = 240): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maximumLength) {
    const end = speechChunkEnd(remaining, maximumLength);
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
