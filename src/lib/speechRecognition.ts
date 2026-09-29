/**
 * 브라우저의 음성 인식·합성이 이 실행에 있는지 묻는 자리와, 그 인식기가 우리에게 보이는
 * 최소 모양.
 *
 * 문구 표(`voiceText`)와는 서로 읽을 것이 없다. 여기는 `window`의 전역 이름만 보고 답을
 * 내며, 어떤 로케일에서 도는지도 지금 상태가 무엇인지도 모른다. 답이 달라지는 이유는
 * 브라우저가 노출하는 이름(웹킷 접두 같은 것)이 바뀔 때뿐이다.
 *
 * 타입 선언을 여기 함께 두는 것은 그것이 곧 "브라우저가 주는 것"의 서술이기 때문이다.
 * 표준 lib.dom에 아직 없어 우리가 직접 적고 있으며, 인식기를 실제로 모는 컴포넌트가
 * 핸들러를 달 때 이 모양을 그대로 본다.
 */

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

interface SpeechRecognitionEventLike extends Event {
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
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

/**
 * 생성자를 부를 때마다 `window`에서 다시 읽는다. 모듈 적재 시점에 붙들어 두면 테스트가
 * 가짜 생성자로 갈아 끼울 자리가 없어진다(`cypress/e2e` 음성 입력 스펙이 그렇게 몬다).
 */
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
