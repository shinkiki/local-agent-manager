import { isProviderId } from "../lib/providerIds";
import type { ProviderId, ReasoningEffort } from "../types";

/**
 * 채팅 화면이 로컬 저장소에 남기는 화면 설정. 키 세 개와 그 값을 읽고 쓰는 규칙이
 * ChatView 본문 앞뒤에 흩어져 있으면 어떤 키가 어떤 모양으로 남는지 보려고 1900줄을
 * 오가야 하고, 키 이름이 겹치는지도 한눈에 확인할 수 없다. 화면 동작에 필요한 값이
 * 아니라 "지난번에 어떻게 두었는지"만 담기므로 읽기·쓰기 실패는 모두 삼킨다.
 */

/** 채팅 목록 서랍이 열려 있었는지. 값의 해석은 secondaryPane 쪽이 한다. */
export const CHAT_LIST_OPEN_KEY = "agent-manager.chat-list-pane";

const HIDDEN_CLI_CONNECTION_CARDS_KEY = "agent-manager.hidden-cli-connection-cards.v1";
const CHAT_LAUNCH_SETTINGS_KEY = "agent-manager.chat-launch-settings";

/**
 * 로컬 저장소는 브라우저 설정·용량에 따라 읽기와 쓰기 어느 쪽도 던질 수 있고, 담긴 값은
 * 지난 버전이 남긴 아무 모양이나 될 수 있다. 이 화면이 저장하는 것은 모두 화면 설정이라
 * 실패해도 이번 실행을 막지 않아야 하므로, 같은 try/catch 껍데기를 여기 한 벌로 모은다.
 * 값의 모양 검사는 그대로 각 호출부가 한다.
 */
function readStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장소를 쓸 수 없는 환경에서도 이번 실행의 화면 동작은 그대로 유지한다.
  }
}

/**
 * 기억해 둔 "다시 표시 안 함" 목록. 공급자 이름은 정본 목록으로 거른다 — 여기에 세
 * 이름을 손으로 적어 두면 공급자가 늘었을 때 그 공급자의 기억만 조용히 깨진다.
 */
export function readHiddenCliConnectionCards(): ProviderId[] {
  const stored = readStoredJson<unknown>(HIDDEN_CLI_CONNECTION_CARDS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.filter((provider): provider is ProviderId => isProviderId(provider));
}

export function writeHiddenCliConnectionCards(providers: ProviderId[]): void {
  writeStoredJson(HIDDEN_CLI_CONNECTION_CARDS_KEY, providers);
}

/** 새 채팅 시작 칸이 공급자마다 기억하는 값. */
interface ChatLaunchSettings {
  model: string;
  reasoningEffort: ReasoningEffort | "";
  /** 로컬 공급자의 서빙 연결 id(M7). 빈 값은 기본 연결. 옛 저장본에는 없다. */
  localConnectionId?: string;
}

type StoredChatLaunchSettings = Record<string, Partial<ChatLaunchSettings>> | null;

export function readChatLaunchSettings(source: ProviderId): ChatLaunchSettings {
  const entry = readStoredJson<StoredChatLaunchSettings>(CHAT_LAUNCH_SETTINGS_KEY, null)?.[source];
  return {
    model: typeof entry?.model === "string" ? entry.model : "",
    reasoningEffort: typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : "",
    localConnectionId: typeof entry?.localConnectionId === "string" ? entry.localConnectionId : "",
  };
}

export function saveChatLaunchSettings(source: ProviderId, settings: ChatLaunchSettings) {
  const stored = readStoredJson<StoredChatLaunchSettings>(CHAT_LAUNCH_SETTINGS_KEY, null);
  writeStoredJson(CHAT_LAUNCH_SETTINGS_KEY, { ...stored, [source]: settings });
}
