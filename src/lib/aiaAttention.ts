import type { ChatAttentionItem, ChatAttentionSnapshot } from "../types";
import { recountAttention } from "./chatAttention.ts";

export function withoutAiaAttention(snapshot: ChatAttentionSnapshot): ChatAttentionSnapshot {
  return recountAttention(snapshot.items.filter((item) => item.profile !== "aia"));
}

export function selectAiaAttention(items: ChatAttentionItem[]): ChatAttentionItem | null {
  const aiaItems = items.filter((item) => item.profile === "aia");
  return aiaItems.find((item) => item.kind === "approval")
    ?? aiaItems.find((item) => !item.read && (item.kind === "completed" || item.kind === "failed"))
    ?? null;
}

/** 알림 대상(attentionTarget)을 받은 팝업이 취할 행동. */
export type AiaAttentionTargetAction = "switch" | "reject" | "wait";

/**
 * CLI 미연결이면 조용히 기다리는 대신 실패로 소비한다. 기다리면 알림 클릭이
 * 무반응처럼 보이고, 대상이 남아 나중에 CLI가 붙는 순간 오래된 전환이 일어난다.
 */
export function aiaAttentionTargetAction(
  open: boolean,
  providerConnected: boolean,
  starting: boolean,
): AiaAttentionTargetAction {
  if (!open) return "wait";
  if (!providerConnected) return "reject";
  return starting ? "wait" : "switch";
}

/** 트리거 옆 말풍선에 띄울 대화 미리보기. 원문 대신 앞부분만 담는다. */
export interface AiaAttentionBubble {
  request: string | null;
  response: string;
}

/** 닫은 미리보기는 같은 알림에만 적용하고, 다음 알림은 다시 보여 준다. */
export function shouldShowAiaAttentionBubble(
  popupOpen: boolean,
  bubbleKey: string | null,
  closedBubbleKey: string | null,
): boolean {
  return !popupOpen && bubbleKey !== null && bubbleKey !== closedBubbleKey;
}

const MAX_BUBBLE_REQUEST_CHARS = 90;
/**
 * 말풍선 답변 줄에 담을 최대 글자 수. `.aia-attention-bubble-response`가 실제로 그리는
 * 줄 수에 맞춘 값이다. 이보다 크면 남은 글자를 CSS가 다시 잘라, 경계까지 맞춰 놓은
 * 미리보기가 글자 중간에서 끊긴다.
 *
 * `chat.rs`의 `MAX_PREVIEW_RESPONSE_CHARS`와 같은 값이어야 한다. 더 작으면 백엔드가
 * 문장 경계까지 맞춰 보낸 미리보기를 여기서 한 번 더 자르게 된다.
 */
const MAX_BUBBLE_RESPONSE_CHARS = 120;
/** 상한의 몇 %보다 뒤에서만 낱말·문장 경계를 찾을지. `text_limit.rs`와 같은 기준이다. */
const BOUNDARY_MIN_RATIO = 0.6;
const SENTENCE_END = /[.!?。！？…]/u;

/**
 * 알림 하나를 말풍선 두 줄(요청·응답)로 옮긴다. 승인 대기는 아직 응답이 없으므로
 * 승인 요청 내용을 응답 자리에 쓴다. 띄울 내용이 없으면 null이다.
 */
export function aiaAttentionBubble(item: ChatAttentionItem | null): AiaAttentionBubble | null {
  if (!item) return null;
  const response = item.kind === "approval"
    ? item.detail?.trim() || item.title
    : item.preview?.response ?? null;
  const trimmed = clampBubbleText(response, MAX_BUBBLE_RESPONSE_CHARS);
  if (!trimmed) return null;
  return { request: clampBubbleText(item.preview?.request ?? null, MAX_BUBBLE_REQUEST_CHARS), response: trimmed };
}

/**
 * 공백을 한 칸으로 정리하고, 제한 글자 수를 넘으면 낱말·문장을 끊지 않는 자리에서
 * 말줄임표로 마무리한다.
 *
 * 마크다운 표기는 여기서 걷지 않는다. 대화 미리보기는 백엔드가 이미 순수 텍스트로
 * 옮겨 보내고, 이 함수가 함께 다루는 승인 요청 문구는 마크다운이 아니다.
 */
function clampBubbleText(text: string | null | undefined, limit: number): string | null {
  const collapsed = (text ?? "").split(/\s+/u).filter(Boolean).join(" ");
  if (!collapsed) return null;
  const chars = [...collapsed];
  if (chars.length <= limit) return collapsed;
  return `${chars.slice(0, bubbleCutIndex(chars, limit)).join("").trimEnd()}…`;
}

/**
 * 상한 안쪽에서 끊을 자리를 고른다. 마지막 문장 끝을 먼저 찾고, 없으면 마지막 공백을
 * 쓴다. 상한의 `BOUNDARY_MIN_RATIO` 앞까지 물러나면 내용이 너무 줄어들므로, 그 안에
 * 경계가 없으면 상한에서 그대로 끊는다.
 */
function bubbleCutIndex(chars: string[], limit: number): number {
  const floor = Math.floor(limit * BOUNDARY_MIN_RATIO);
  for (let index = limit - 1; index >= floor; index -= 1) {
    // 뒤가 공백일 때만 문장 끝으로 본다. 그러지 않으면 `1.5`의 소수점에서 끊긴다.
    if (SENTENCE_END.test(chars[index]) && (chars[index + 1] ?? " ") === " ") return index + 1;
  }
  for (let index = limit - 1; index >= floor; index -= 1) {
    if (chars[index] === " ") return index;
  }
  return limit;
}
