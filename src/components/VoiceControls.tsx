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
 * 문구는 한국어·영어 짝으로 들고 다니다 그릴 때 언어를 고른다. 모듈 수준 재생 상태와
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
    failPlayback(responseId, { ko: "이 환경은 답변 음성 재생을 지원하지 않습니다.", en: "This environment does not support spoken playback of responses." });
    return;
  }

  const chunks = splitSpeechText(speechTextFromMarkdown(markdown));
  if (chunks.length === 0) {
    failPlayback(responseId, { ko: "읽을 수 있는 최종 답변이 없습니다.", en: "There is no final response to read aloud." });
    return;
  }

  window.speechSynthesis.cancel();
  updatePlayback({ status: "playing", responseId, error: null });
  let index = 0;
  const speakNext = () => {
    if (generation !== playbackGeneration) return;
    const text = chunks[index];
    if (!text) {
      resetPlayback();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLang();
    utterance.onend = () => {
      if (generation !== playbackGeneration) return;
      index += 1;
      speakNext();
    };
    utterance.onerror = (event) => {
      if (generation !== playbackGeneration) return;
      if (event.error === "canceled" || event.error === "interrupted") {
        resetPlayback();
        return;
      }
      failPlayback(responseId, { ko: "답변을 재생하지 못했습니다. 시스템 음성 설정을 확인해 주세요.", en: "The response could not be played. Check the system speech settings." });
    };
    window.speechSynthesis.speak(utterance);
  };
  speakNext();
}

/**
 * 전사를 지원하지 않는 환경에서 버튼 설명과 상태 문구가 함께 쓰는 안내. 두 자리에
 * 손으로 적어 두면 한쪽만 고쳐져 같은 상황을 두 문장으로 알리게 된다.
 */
const RECOGNITION_UNSUPPORTED: VoiceText = {
  ko: "이 브라우저 또는 WebView는 음성 전사를 지원하지 않습니다. 텍스트 입력을 사용해 주세요.",
  en: "This browser or WebView does not support speech transcription. Use text input instead.",
};

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
    setInputError(message);
    setInputStatus("error");
  }, []);

  const finishTranscript = useCallback(() => {
    if (failedRef.current) return;
    const transcript = normalizeSpeechTranscript(transcriptRef.current);
    recognitionRef.current = null;
    if (!transcript) {
      failInput({ ko: "전사된 문장이 없습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.", en: "Nothing was transcribed. Speak closer to the microphone and try again." });
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
      failInput({ ko: "음성 입력을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.", en: "Voice input could not be started. Try again in a moment." });
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

  const effectiveStatus: VoiceStatus = playback.status === "playing"
    ? "playing"
    : !recognitionSupported && inputStatus === "idle"
      ? "error"
      : playback.status === "error" && inputStatus === "idle"
        ? "error"
        : inputStatus;
  const effectiveError = inputStatus === "error"
    ? inputError
    : !recognitionSupported
      ? RECOGNITION_UNSUPPORTED
      : playback.status === "error"
        ? playback.error
        : null;
  const statusText = voiceStatusText(effectiveStatus, effectiveError);
  const statusMessage = text(statusText.ko, statusText.en);
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
      ? (playback.error ? text(playback.error.ko, playback.error.en) : text("음성 재생 실패", "Playback failed"))
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
