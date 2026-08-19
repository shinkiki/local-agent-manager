export type VoiceStatus = "idle" | "recording" | "transcribing" | "ready" | "playing" | "error";

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

export function speechRecognitionErrorMessage(code: string): string {
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "마이크 권한이 거부되었습니다. 브라우저 또는 앱 설정에서 마이크 접근을 허용해 주세요.";
  }
  if (code === "audio-capture") return "사용할 수 있는 마이크를 찾지 못했습니다. 장치 연결과 입력 설정을 확인해 주세요.";
  if (code === "no-speech") return "음성이 감지되지 않았습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.";
  if (code === "network") return "음성 전사 서비스에 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.";
  if (code === "language-not-supported") return "현재 언어는 이 환경의 음성 전사에서 지원되지 않습니다.";
  if (code === "aborted") return "음성 입력이 취소되었습니다.";
  return "음성을 전사하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function voiceStatusMessage(status: VoiceStatus, error: string | null = null): string {
  if (status === "recording") return "녹음 중 · 다시 누르면 전사를 시작합니다";
  if (status === "transcribing") return "전사 중…";
  if (status === "ready") return "전사 완료 · 문장을 확인·수정한 뒤 전송하세요";
  if (status === "playing") return "답변 재생 중 · 정지는 오디오만 멈춥니다";
  if (status === "error") return error ?? "음성 기능을 사용할 수 없습니다.";
  return "음성 입력";
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

export function splitSpeechText(text: string, maximumLength = 240): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maximumLength) {
    const windowText = remaining.slice(0, maximumLength + 1);
    const sentenceEnd = Math.max(
      windowText.lastIndexOf(". "),
      windowText.lastIndexOf("! "),
      windowText.lastIndexOf("? "),
      windowText.lastIndexOf("。"),
      windowText.lastIndexOf("다. "),
    );
    const whitespace = windowText.lastIndexOf(" ");
    const end = sentenceEnd >= Math.floor(maximumLength * 0.45)
      ? sentenceEnd + 1
      : whitespace > 0
        ? whitespace
        : maximumLength;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
