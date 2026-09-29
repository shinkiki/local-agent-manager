/**
 * 음성 입력으로 받은 말을 작성 중인 초안에 얹는 규칙과, 어떤 답변을 낭독 대상으로 볼지.
 *
 * 나머지 셋은 각자 자기 파일이 소유한다 — 브라우저가 음성 인식·합성을 가졌는지는
 * `speechRecognition`, 상태·오류 문구는 `voiceText`, 낭독할 글 만들기는 `speechText`다.
 * 넷은 답이 달라지는 이유가 서로 달라 갈랐지만, 쓰는 쪽(음성 컨트롤과 대화 화면)이 그
 * 사정을 알아야 할 이유는 없으므로 창구는 이 모듈 하나로 둔다 — 나눈 쪽의 사정이 호출부의
 * import 목록으로 새어 나가면 다음에 다시 나눌 때마다 호출부를 함께 고쳐야 한다.
 */

export {
  speechPlaybackSupported,
  speechRecognitionConstructor,
  type SpeechRecognitionLike,
} from "./speechRecognition.ts";
export {
  speechRecognitionErrorText,
  voiceStatusText,
  type VoiceStatus,
  type VoiceText,
} from "./voiceText.ts";
export { speechTextFromMarkdown, splitSpeechText } from "./speechText.ts";

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

export function isReadableFinalResponse(turnStatus: string, isLastAssistantMessage: boolean): boolean {
  return isLastAssistantMessage && (turnStatus === "completed" || turnStatus === "completedWithDenials");
}
