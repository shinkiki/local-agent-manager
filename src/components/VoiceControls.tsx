import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square, Volume2 } from "lucide-react";
import { useI18n } from "../lib/i18n";
import {
  mergeSpeechTranscript,
  normalizeSpeechTranscript,
  speechPlaybackSupported,
  speechRecognitionConstructor,
  speechRecognitionErrorText,
  speechTextFromMarkdown,
  splitSpeechText,
  voiceStatusText,
  type SpeechRecognitionLike,
  type VoiceStatus,
  type VoiceText,
} from "../lib/voice";

/**
 * 문구는 언어 손잡이를 받는 함수로 들고 다니다 그릴 때 언어를 고른다. 모듈 수준 재생 상태와
 * 콜백 안에서 만들어지는 오류는 React 문맥 밖이라 이때 언어를 정할 수 없기 때문이다.
 */
interface PlaybackSnapshot {
  status: "idle" | "playing" | "error";
  responseId: string | null;
  error: VoiceText | null;
}

const playbackListeners = new Set<() => void>();
const serverPlaybackSnapshot: PlaybackSnapshot = { status: "idle", responseId: null, error: null };
let playbackSnapshot = serverPlaybackSnapshot;
let playbackGeneration = 0;

function updatePlayback(next: PlaybackSnapshot) {
  playbackSnapshot = next;
  playbackListeners.forEach((listener) => listener());
}

/** 재생이 끝났거나 취소됐을 때 되돌아가는 자리. */
function resetPlayback() {
  updatePlayback(serverPlaybackSnapshot);
}

/** 재생 실패는 어느 지점에서 걸리든 같은 모양으로 남긴다. */
function failPlayback(responseId: string, error: VoiceText) {
  updatePlayback({ status: "error", responseId, error });
}

/**
 * 음성 입력·재생이 함께 쓰는 발화 언어. 문서 언어를 먼저 따르고, 없으면 브라우저 언어,
 * 그것도 없으면 기본 한국어로 떨어진다. 입력과 재생이 서로 다른 언어를 집으면 받아쓴
 * 문장과 읽어 주는 목소리가 어긋난다.
 */
function speechLang(): string {
  return document.documentElement.lang || navigator.language || "ko-KR";
}

function subscribePlayback(listener: () => void) {
  playbackListeners.add(listener);
  return () => playbackListeners.delete(listener);
}

function stopResponseAudio() {
  playbackGeneration += 1;
  if (speechPlaybackSupported()) window.speechSynthesis.cancel();
  resetPlayback();
}

function playResponse(responseId: string, markdown: string) {
  playbackGeneration += 1;
  const generation = playbackGeneration;
  if (!speechPlaybackSupported()) {
    failPlayback(responseId, (text) => text("이 환경은 답변 음성 재생을 지원하지 않습니다.", "This environment does not support spoken playback of responses."));
    return;
  }

  const chunks = splitSpeechText(speechTextFromMarkdown(markdown));
  if (chunks.length === 0) {
    failPlayback(responseId, (text) => text("읽을 수 있는 최종 답변이 없습니다.", "There is no final response to read aloud."));
    return;
  }

  window.speechSynthesis.cancel();
  updatePlayback({ status: "playing", responseId, error: null });
  let index = 0;
  /**
   * 이 재생이 아직 살아 있는지. 재생은 조각 하나마다 콜백으로 이어지므로, 그사이 정지를
   * 눌렀거나 다른 답변 재생이 시작됐으면 뒤늦게 도착한 콜백은 아무것도 해서는 안 된다 —
   * 그대로 두면 이미 끝난 재생이 새 재생의 상태를 idle로 되돌리거나 오류로 덮는다.
   * 판정을 세 콜백이 각자 적으면 한 자리만 빠뜨려도 그 갈래에서만 어긋난다.
   */
  const current = () => generation === playbackGeneration;
  const speakNext = () => {
    if (!current()) return;
    const text = chunks[index];
    if (!text) {
      resetPlayback();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLang();
    utterance.onend = () => {
      if (!current()) return;
      index += 1;
      speakNext();
    };
    utterance.onerror = (event) => {
      if (!current()) return;
      if (event.error === "canceled" || event.error === "interrupted") {
        resetPlayback();
        return;
      }
      failPlayback(responseId, (text) => text("답변을 재생하지 못했습니다. 시스템 음성 설정을 확인해 주세요.", "The response could not be played. Check the system speech settings."));
    };
    window.speechSynthesis.speak(utterance);
  };
  speakNext();
}

/**
 * 전사를 지원하지 않는 환경에서 버튼 설명과 상태 문구가 함께 쓰는 안내. 두 자리에
 * 손으로 적어 두면 한쪽만 고쳐져 같은 상황을 두 문장으로 알리게 된다.
 */
const RECOGNITION_UNSUPPORTED: VoiceText = (text) => text(
  "이 브라우저 또는 WebView는 음성 전사를 지원하지 않습니다. 텍스트 입력을 사용해 주세요.",
  "This browser or WebView does not support speech transcription. Use text input instead.",
);

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
 * 화면에 닿으므로(`voiceStatusText`), 나머지 갈래는 null로 둔다.
 */
function voiceButtonState(
  inputStatus: Exclude<VoiceStatus, "playing">,
  inputError: VoiceText | null,
  playback: PlaybackSnapshot,
  recognitionSupported: boolean,
): { status: VoiceStatus; error: VoiceText | null } {
  // 재생 중은 다른 무엇보다 먼저다. 이 버튼이 그때 하는 일(누르면 녹음이 재생을 끊는다)이
  // 다른 상태와 다르기 때문이다.
  if (playback.status === "playing") return { status: "playing", error: null };
  // 내 입력이 진행·실패 중이면 그것이 사용자가 방금 한 일이므로 재생 쪽 사정보다 앞선다.
  if (inputStatus === "error") return { status: "error", error: inputError };
  if (inputStatus !== "idle") return { status: inputStatus, error: null };
  // 아무것도 하지 않는 동안에만 환경 제약과 지난 재생 실패가 드러난다.
  if (!recognitionSupported) return { status: "error", error: RECOGNITION_UNSUPPORTED };
  if (playback.status === "error") return { status: "error", error: playback.error };
  return { status: "idle", error: null };
}

function usePlaybackSnapshot() {
  return useSyncExternalStore(subscribePlayback, () => playbackSnapshot, () => serverPlaybackSnapshot);
}

export function VoiceInputControl({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { text } = useI18n();
  const [inputStatus, setInputStatus] = useState<Exclude<VoiceStatus, "playing">>("idle");
  const [inputError, setInputError] = useState<VoiceText | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const failedRef = useRef(false);
  const valueRef = useRef(value);
  const playback = usePlaybackSnapshot();
  const recognitionSupported = speechRecognitionConstructor() !== null;

  valueRef.current = value;

  /** 입력 실패는 어느 지점에서 걸리든 문구와 상태를 함께 남긴다. */
  const failInput = useCallback((message: VoiceText) => {
    // 문구가 함수라 그대로 넘기면 React가 갱신 함수로 보고 불러 버린다. 한 겹 감싸 값으로 넣는다.
    setInputError(() => message);
    setInputStatus("error");
  }, []);

  const finishTranscript = useCallback(() => {
    if (failedRef.current) return;
    const transcript = normalizeSpeechTranscript(transcriptRef.current);
    recognitionRef.current = null;
    if (!transcript) {
      failInput((text) => text("전사된 문장이 없습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.", "Nothing was transcribed. Speak closer to the microphone and try again."));
      return;
    }
    onChange(mergeSpeechTranscript(valueRef.current, transcript));
    setInputError(null);
    setInputStatus("ready");
  }, [failInput, onChange]);

  useEffect(() => () => {
    failedRef.current = true;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) recognition.abort();
  }, []);

  useEffect(() => {
    if (!value && inputStatus === "ready") setInputStatus("idle");
  }, [inputStatus, value]);

  /**
   * 인식기를 새로 열고 콜백을 매단다. 버튼이 무엇을 할지 고르는 판단(toggleRecording)과
   * 인식기를 실제로 세우는 절차를 갈라 두면, 상태 전이를 읽을 때 인식기 배선까지 함께
   * 훑지 않아도 된다.
   */
  const startRecording = (Recognition: NonNullable<ReturnType<typeof speechRecognitionConstructor>>) => {
    stopResponseAudio();
    failedRef.current = false;
    transcriptRef.current = "";
    setInputError(null);
    const recognition = new Recognition();
    recognition.lang = speechLang();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setInputStatus("recording");
    recognition.onresult = (event) => {
      const segments: string[] = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const transcript = event.results[index]?.[0]?.transcript;
        if (transcript) segments.push(transcript);
      }
      transcriptRef.current = segments.join(" ");
    };
    recognition.onerror = (event) => {
      failedRef.current = true;
      recognitionRef.current = null;
      failInput(speechRecognitionErrorText(event.error));
    };
    recognition.onend = () => {
      if (failedRef.current) return;
      setInputStatus("transcribing");
      window.setTimeout(finishTranscript, 0);
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      failInput((text) => text("음성 입력을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.", "Voice input could not be started. Try again in a moment."));
    }
  };

  const toggleRecording = () => {
    if (inputStatus === "recording") {
      setInputStatus("transcribing");
      recognitionRef.current?.stop();
      return;
    }
    if (inputStatus === "transcribing" || disabled) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      failInput(RECOGNITION_UNSUPPORTED);
      return;
    }
    startRecording(Recognition);
  };

  const { status: effectiveStatus, error: effectiveError } = voiceButtonState(inputStatus, inputError, playback, recognitionSupported);
  const statusMessage = voiceStatusText(effectiveStatus, effectiveError)(text);
  return <>
    <button
      className={`voice-input-button voice-status-${effectiveStatus}`}
      type="button"
      disabled={disabled || inputStatus === "transcribing"}
      aria-label={inputStatus === "recording" ? text("녹음 종료하고 전사", "Stop recording and transcribe") : text("음성 입력 시작", "Start voice input")}
      aria-pressed={inputStatus === "recording"}
      title={statusMessage}
      onClick={toggleRecording}
    >
      {inputStatus === "recording" ? <Square size={15} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}
    </button>
    {effectiveStatus !== "idle" && <span className={`voice-status-message voice-status-${effectiveStatus}`} role={effectiveStatus === "error" ? "alert" : "status"} aria-live="polite">
      {statusMessage}
    </span>}
  </>;
}

export function SpeechPlaybackAction({ responseId, text: markdown }: { responseId: string; text: string }) {
  const { text } = useI18n();
  const playback = usePlaybackSnapshot();
  const active = playback.status === "playing" && playback.responseId === responseId;
  const failed = playback.status === "error" && playback.responseId === responseId;
  const label = active
    ? text("읽기 정지 · 오디오만 중단", "Stop reading · audio only")
    : failed
      ? (playback.error ? playback.error(text) : text("음성 재생 실패", "Playback failed"))
      : text("최종 답변 읽기", "Read the final response");
  return <button
    className={`voice-playback-action${active ? " is-playing" : ""}${failed ? " is-error" : ""}`}
    type="button"
    aria-label={label}
    aria-pressed={active}
    title={label}
    onClick={() => active ? stopResponseAudio() : playResponse(responseId, markdown)}
  >
    {active ? <Square size={13} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
    <span>{active ? text("정지", "Stop") : failed ? text("재생 실패", "Failed") : text("읽기", "Read")}</span>
  </button>;
}
