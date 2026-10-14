import type { ChatAttentionItem, ChatAttentionSnapshot } from "../types";
import { clampPreviewText } from "./aiaPreviewText.ts";
import { recountAttention } from "./chatAttention.ts";

/** AIA 프로필 알림 항목인지 여부. */
function isAiaAttention(item: ChatAttentionItem): boolean {
  return item.profile === "aia";
}

/**
 * AIA 창이 가져갈 알림인지 — 프로필이 AIA이고 **이 창이 소유한 대화**의 것인지.
 *
 * 프로필만으로는 가를 수 없다. 세션 화면에서 AIA 작업공간 세션을 재개하면 백엔드가 프로필을
 * Aia 로 되살리는데(`chat.rs::effective_chat_profile`), 프로필만 보고 고르면 그 대화가
 * AIA 창으로 끌려 들어간다 — 사용자가 세션 화면에서 이어 보려고 재개한 대화를 팝업이
 * 빼앗는 꼴이다. ↻ 로 떼어 내고 계속 돌게 둔 대화도 같다. 소유하지 않은 AIA 알림은 일반
 * 알림 목록에 그대로 남아 세션 화면으로 열린다(`appChatAttention`의 `openAttentionItem`).
 */
function isOwnAiaAttention(item: ChatAttentionItem, ownedChatId: string | null): boolean {
  return isAiaAttention(item) && ownedChatId !== null && item.chatId === ownedChatId;
}

/** 대화 턴이 완료되었거나 실패하여 종료된 상태인지 여부. */
function isTerminalAttention(item: ChatAttentionItem): boolean {
  return item.kind === "completed" || item.kind === "failed";
}

/**
 * 일반 알림 목록에서 AIA 창이 맡은 알림만 뺀다. 소유하지 않은 AIA 프로필 알림(세션 화면에서
 * 재개한 세션, ↻ 로 떼어 두고 계속 도는 대화)은 남긴다 — 트리거가 가져가지 않는 알림까지
 * 여기서 빼면 그 대화의 턴이 끝난 것을 어디에서도 알 수 없다.
 */
export function withoutAiaAttention(snapshot: ChatAttentionSnapshot, ownedChatId: string | null): ChatAttentionSnapshot {
  return recountAttention(snapshot.items.filter((item) => !isOwnAiaAttention(item, ownedChatId)));
}

/**
 * 버린 AIA 대화(새로 시작하거나 실행설정이 어긋나 정지한 대화)에 남은 알림.
 *
 * 턴이 끝날 때마다 완료 알림이 하나 남고, 그 알림이 미확인으로 있으면 상단바 트리거는
 * 팝업을 여는 대신 그 알림의 대화로 전환한다(`toggleAia`). 보고 있던 대화와 같을 때는
 * 전환이 제자리라 티가 나지 않지만, 새로고침으로 대화를 새로 시작한 뒤에는 방금 버린
 * 대화를 도로 열어 준다 — 닫았다 다시 열면 이전 세션이 돌아오는 갈래가 이것이다.
 * 그래서 대화를 버릴 때 그 대화의 알림도 함께 걷는다.
 */
export function aiaAttentionForChat(items: ChatAttentionItem[], chatId: string): ChatAttentionItem[] {
  return items.filter((item) => isAiaAttention(item) && item.chatId === chatId);
}

export function selectAiaAttention(items: ChatAttentionItem[], ownedChatId: string | null): ChatAttentionItem | null {
  let unreadTerminal: ChatAttentionItem | null = null;
  for (const item of items) {
    if (!isOwnAiaAttention(item, ownedChatId)) continue;
    if (item.kind === "approval") return item;
    if (unreadTerminal === null && !item.read && isTerminalAttention(item)) {
      unreadTerminal = item;
    }
  }
  return unreadTerminal;
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

/**
 * 말풍선에 띄울 원문 응답 텍스트. 승인 대기는 아직 응답이 없으므로 세부 승인 내용이나
 * 제목을 쓰고, 그 밖에는 미리보기 응답을 그대로 쓴다.
 */
function bubbleResponseText(item: ChatAttentionItem): string | null {
  return item.kind === "approval"
    ? item.detail?.trim() || item.title
    : item.preview?.response ?? null;
}

/**
 * 알림 하나를 말풍선 두 줄(요청·응답)로 옮긴다. 승인 대기는 아직 응답이 없으므로
 * 승인 요청 내용을 응답 자리에 쓴다. 띄울 내용이 없으면 null이다.
 */
export function aiaAttentionBubble(item: ChatAttentionItem | null): AiaAttentionBubble | null {
  if (!item) return null;
  const trimmed = clampPreviewText(bubbleResponseText(item), MAX_BUBBLE_RESPONSE_CHARS);
  if (!trimmed) return null;
  return { request: clampPreviewText(item.preview?.request ?? null, MAX_BUBBLE_REQUEST_CHARS), response: trimmed };
}
