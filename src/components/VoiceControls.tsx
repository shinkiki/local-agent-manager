import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square, Volume2 } from "lucide-react";
import {
  mergeSpeechTranscript,
  normalizeSpeechTranscript,
  speechPlaybackSupported,
  speechRecognitionConstructor,
  speechRecognitionErrorMessage,
  speechTextFromMarkdown,
  splitSpeechText,
  voiceStatusMessage,
  type SpeechRecognitionLike,
  type VoiceStatus,
} from "../lib/voice";

interface PlaybackSnapshot {
  status: "idle" | "playing" | "error";
  responseId: string | null;
  error: string | null;
}

const playbackListeners = new Set<() => void>();
const serverPlaybackSnapshot: PlaybackSnapshot = { status: "idle", responseId: null, error: null };
let playbackSnapshot = serverPlaybackSnapshot;
let playbackGeneration = 0;

function updatePlayback(next: PlaybackSnapshot) {
  playbackSnapshot = next;
  playbackListeners.forEach((listener) => listener());
}

function subscribePlayback(listener: () => void) {
  playbackListeners.add(listener);
  return () => playbackListeners.delete(listener);
}

function stopResponseAudio() {
  playbackGeneration += 1;
  if (speechPlaybackSupported()) window.speechSynthesis.cancel();
  updatePlayback(serverPlaybackSnapshot);
}

function playResponse(responseId: string, markdown: string) {
  playbackGeneration += 1;
  const generation = playbackGeneration;
  if (!speechPlaybackSupported()) {
    updatePlayback({
      status: "error",
      responseId,
      error: "이 환경은 답변 음성 재생을 지원하지 않습니다.",
    });
    return;
  }

  const chunks = splitSpeechText(speechTextFromMarkdown(markdown));
  if (chunks.length === 0) {
    updatePlayback({ status: "error", responseId, error: "읽을 수 있는 최종 답변이 없습니다." });
    return;
  }

  window.speechSynthesis.cancel();
  updatePlayback({ status: "playing", responseId, error: null });
  let index = 0;
  const speakNext = () => {
    if (generation !== playbackGeneration) return;
    const text = chunks[index];
    if (!text) {
      updatePlayback(serverPlaybackSnapshot);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || navigator.language || "ko-KR";
    utterance.onend = () => {
      if (generation !== playbackGeneration) return;
      index += 1;
      speakNext();
    };
    utterance.onerror = (event) => {
      if (generation !== playbackGeneration) return;
      if (event.error === "canceled" || event.error === "interrupted") {
        updatePlayback(serverPlaybackSnapshot);
        return;
      }
      updatePlayback({
        status: "error",
        responseId,
        error: "답변을 재생하지 못했습니다. 시스템 음성 설정을 확인해 주세요.",
      });
    };
    window.speechSynthesis.speak(utterance);
  };
  speakNext();
}

function usePlaybackSnapshot() {
  return useSyncExternalStore(subscribePlayback, () => playbackSnapshot, () => serverPlaybackSnapshot);
}

export function VoiceInputControl({ value, disabled, onChange }: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [inputStatus, setInputStatus] = useState<Exclude<VoiceStatus, "playing">>("idle");
  const [inputError, setInputError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const failedRef = useRef(false);
  const valueRef = useRef(value);
  const playback = usePlaybackSnapshot();
  const recognitionSupported = speechRecognitionConstructor() !== null;

  valueRef.current = value;

  const finishTranscript = useCallback(() => {
    if (failedRef.current) return;
    const transcript = normalizeSpeechTranscript(transcriptRef.current);
    recognitionRef.current = null;
    if (!transcript) {
      const message = "전사된 문장이 없습니다. 마이크에 가까이 말한 뒤 다시 시도해 주세요.";
      setInputError(message);
      setInputStatus("error");
      return;
    }
    onChange(mergeSpeechTranscript(valueRef.current, transcript));
    setInputError(null);
    setInputStatus("ready");
  }, [onChange]);

  useEffect(() => () => {
    failedRef.current = true;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) recognition.abort();
  }, []);

  useEffect(() => {
    if (!value && inputStatus === "ready") setInputStatus("idle");
  }, [inputStatus, value]);

  const toggleRecording = () => {
    if (inputStatus === "recording") {
      setInputStatus("transcribing");
      recognitionRef.current?.stop();
      return;
    }
    if (inputStatus === "transcribing" || disabled) return;
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setInputError("이 브라우저 또는 WebView는 음성 전사를 지원하지 않습니다. 텍스트 입력을 사용해 주세요.");
      setInputStatus("error");
      return;
    }

    stopResponseAudio();
    failedRef.current = false;
    transcriptRef.current = "";
    setInputError(null);
    const recognition = new Recognition();
    recognition.lang = document.documentElement.lang || navigator.language || "ko-KR";
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
      setInputError(speechRecognitionErrorMessage(event.error));
      setInputStatus("error");
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
      setInputError("음성 입력을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setInputStatus("error");
    }
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
      ? "이 브라우저 또는 WebView는 음성 전사를 지원하지 않습니다. 텍스트 입력을 사용해 주세요."
      : playback.status === "error"
        ? playback.error
        : null;
  const statusMessage = voiceStatusMessage(effectiveStatus, effectiveError);
  return <>
    <button
      className={`voice-input-button voice-status-${effectiveStatus}`}
      type="button"
      disabled={disabled || inputStatus === "transcribing"}
      aria-label={inputStatus === "recording" ? "녹음 종료하고 전사" : "음성 입력 시작"}
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

export function SpeechPlaybackAction({ responseId, text }: { responseId: string; text: string }) {
  const playback = usePlaybackSnapshot();
  const active = playback.status === "playing" && playback.responseId === responseId;
  const failed = playback.status === "error" && playback.responseId === responseId;
  const label = active
    ? "읽기 정지 · 오디오만 중단"
    : failed
      ? playback.error ?? "음성 재생 실패"
      : "최종 답변 읽기";
  return <button
    className={`voice-playback-action${active ? " is-playing" : ""}${failed ? " is-error" : ""}`}
    type="button"
    aria-label={label}
    aria-pressed={active}
    title={label}
    onClick={() => active ? stopResponseAudio() : playResponse(responseId, text)}
  >
    {active ? <Square size={13} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
    <span>{active ? "정지" : failed ? "재생 실패" : "읽기"}</span>
  </button>;
}
