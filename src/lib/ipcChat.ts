/**
 * 실행 중인 채팅과 주목 알림을 다루는 명령. 실행 런타임 조회, 화면 요청 응답, 주목
 * 목록의 읽음·해제가 여기 모인다. 화면이 AIA에게 건네는 제안 카탈로그와 일회성 사건
 * 분석도 여기 둔다 — 둘 다 부르는 쪽이 AIA 대화이고, 그 대화를 띄우는 자리가 바로 이
 * 모듈이 다루는 주목 알림이다.
 *
 * 명령 목록(`ipc.ts`)에 섞여 있으면 예산·스케줄러·설정 명령 사이에 채팅 갈래가 흩어져,
 * 한 왕복으로 끝내야 하는 읽음 처리 같은 규칙이 어디 있는지 보이지 않았다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  AiaOnboardingCatalog,
  ChatAttentionSnapshot,
  ChatProfile,
  ChatProviderOptions,
  ChatSessionInfo,
  LinkedFile,
  ProviderId,
  ShutdownImpact,
} from "../types";
import type { AiaSuggestionCatalog } from "./aiaSuggestions";
import { sessionRef } from "./ipcSessions";
import { call } from "./ipcTransport";

export function getChatProviderOptions(source: ProviderId): Promise<ChatProviderOptions> {
  return call<ChatProviderOptions>("get_chat_provider_options", { source });
}

export function getChatAttentionSnapshot(): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("get_chat_attention_snapshot");
}

/** 기존 IPC 이름은 유지하지만, 다중 화면 attach를 위해 연결 여부와 무관하게 현재
 * 공급자 세션을 관리하는 활성 런타임을 돌려준다. */
export function getDetachedChatForSession(
  source: ProviderId,
  id: string,
): Promise<ChatSessionInfo | null> {
  return call<ChatSessionInfo | null>("get_detached_chat_for_session", { request: sessionRef(source, id) });
}

export function getLiveChats(profile: ChatProfile = "standard"): Promise<ChatSessionInfo[]> {
  return call<ChatSessionInfo[]>("get_live_chats", { profile });
}

/** 지금 백엔드를 내리면 끊기는 실행 수. 종료 확인 창이 묻기 전에 한 번 읽는다. */
export function getShutdownImpact(): Promise<ShutdownImpact> {
  return call<ShutdownImpact>("get_shutdown_impact");
}

/** AIA의 화면 요청(uiQuery·uiClick 이벤트)에 화면이 답한다 — 요소 목록 또는 클릭 결과. */
export function answerUiQuery(queryId: string, answer: unknown): Promise<void> {
  return call<void>("answer_ui_query", { queryId, answer });
}

export function markChatAttentionRead(id: string): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("mark_chat_attention_read", { id });
}

/**
 * 읽음 처리를 한 왕복으로 끝낸다. 항목마다 `markChatAttentionRead`를 부르면 미읽음 수만큼
 * HTTP 왕복이 쌓여, 원격으로 붙었을 때 버튼이 굳은 것처럼 보인다.
 * `excludeProfiles`는 화면 목록에서 감춘 프로필을 대상에서 빼는 데 쓴다.
 */
export function markAllChatAttentionRead(excludeProfiles: ChatProfile[] = []): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("mark_all_chat_attention_read", { excludeProfiles });
}

export function clearReadChatAttention(): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("clear_read_chat_attention");
}

export function dismissChatAttention(id: string): Promise<ChatAttentionSnapshot> {
  return call<ChatAttentionSnapshot>("dismiss_chat_attention", { id });
}

/** 채팅에 적힌 링크 하나를 가리키는 요청 본문. 읽기와 내려받기가 같은 모양을 쓴다
 *  (`sessionLinkedFileRef`와 같은 규칙). */
export type ChatLinkedFileRef = {
  chatId: string;
  href: string;
};

export function chatLinkedFileRef(chatId: string, href: string): ChatLinkedFileRef {
  return { chatId, href };
}

export function getChatLinkedFile(chatId: string, href: string): Promise<LinkedFile> {
  return call<LinkedFile>("get_chat_linked_file", { request: chatLinkedFileRef(chatId, href) });
}

/** 번들 기본 팩과 사용자가 관리하는 공통 스킬 팩을 합성한 읽기 전용 AIA 제안 카탈로그. */
export function getAiaSuggestionCatalog(): Promise<AiaSuggestionCatalog> {
  return call<AiaSuggestionCatalog>("get_aia_suggestion_catalog");
}

/** 자동화 탭의 온보딩 카드. 번들 기본 팩과 공통 스킬 팩을 합쳐 검증한 결과다(W6). */
export function getAiaOnboardingCatalog(): Promise<AiaOnboardingCatalog> {
  return call<AiaOnboardingCatalog>("get_aia_onboarding_catalog");
}

export interface AiaBackgroundAnalysis {
  summary: string;
  command: string | null;
}

/** 누적 대화나 시스템 도구를 쓰지 않는 호스트 전용 일회성 사건 분석. */
export function analyzeAiaEvent(eventSummary: string): Promise<AiaBackgroundAnalysis> {
  return call<AiaBackgroundAnalysis>("analyze_aia_event", { request: { eventSummary } });
}
