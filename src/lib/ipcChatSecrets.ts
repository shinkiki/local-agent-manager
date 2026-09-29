/**
 * 채팅 비밀값 명령. 사용자가 진행 중인 채팅에 이름 붙인 비밀값(API 키·비밀번호)을 맡기면
 * 백엔드가 메모리에만 들고 있다가, 에이전트가 이름으로 참조해 실행할 때 앱이 대신 주입한다.
 * 화면은 이름·용도·만료만 받고 값은 어느 응답에도 실리지 않는다 — 여기 있는 함수 중 값을
 * 돌려주는 것은 없다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 `lib/ipc`다.
 */
import type { ChatSecretsOverview, ChatSecretsSnapshot, ChatSecretValueView, SavedSecretsSnapshot, SavedSecretValueView } from "../types";
import { call } from "./ipcTransport";

export function listChatSecrets(chatId: string): Promise<ChatSecretsSnapshot> {
  return call<ChatSecretsSnapshot>("list_chat_secrets", { chatId });
}

/** 모든 대화의 비밀값 묶음. 저장소 → 비밀정보 탭이 쓴다. 값은 여기에도 실리지 않는다. */
export function listAllChatSecrets(): Promise<ChatSecretsOverview> {
  return call<ChatSecretsOverview>("list_all_chat_secrets", {});
}

/** 호스트 전용 쓰기. 같은 이름이 있으면 덮어쓴다. */
export function setChatSecret(input: { chatId: string; name: string; purpose: string; value: string }): Promise<ChatSecretsSnapshot> {
  return call<ChatSecretsSnapshot>("set_chat_secret", input);
}

export function removeChatSecret(input: { chatId: string; name: string }): Promise<ChatSecretsSnapshot> {
  return call<ChatSecretsSnapshot>("remove_chat_secret", input);
}

/**
 * 값을 그대로 돌려주는 유일한 명령. 저장소 → 비밀정보 탭의 눈 아이콘만 부르며 호스트 화면
 * 전용이다. 받은 값은 화면 상태에만 잠시 두고 숨기는 즉시 지운다.
 */
export function readChatSecretValue(input: { chatId: string; name: string }): Promise<ChatSecretValueView> {
  return call<ChatSecretValueView>("read_chat_secret_value", input);
}

// ---------------------------------------------------------------------------
// C16. 저장된 비밀값. 대화가 끝나도 남고, 에이전트가 이름을 요청하면 자동으로 실린다.
// 값은 OS 보안 저장소에만 있고, 값을 돌려주는 것은 readSavedSecretValue 하나다.
// ---------------------------------------------------------------------------

export function listSavedSecrets(): Promise<SavedSecretsSnapshot> {
  return call<SavedSecretsSnapshot>("list_saved_secrets", {});
}

/** 호스트 전용 쓰기. 같은 이름이 있으면 값과 용도를 덮어쓴다. */
export function saveSecret(input: { name: string; purpose: string; value: string }): Promise<SavedSecretsSnapshot> {
  return call<SavedSecretsSnapshot>("save_secret", input);
}

/** 이 대화가 들고 있는 값을 그대로 보관으로 옮긴다. 값은 백엔드 밖으로 나오지 않는다. */
export function rememberChatSecret(input: { chatId: string; name: string }): Promise<SavedSecretsSnapshot> {
  return call<SavedSecretsSnapshot>("remember_chat_secret", input);
}

/** 자동 사용 토글. 값에는 손대지 않으므로 다시 켜는 데 값을 재입력할 필요가 없다. */
export function setSavedSecretAgentEnabled(input: { name: string; enabled: boolean }): Promise<SavedSecretsSnapshot> {
  return call<SavedSecretsSnapshot>("set_saved_secret_agent_enabled", input);
}

export function removeSavedSecret(input: { name: string }): Promise<SavedSecretsSnapshot> {
  return call<SavedSecretsSnapshot>("remove_saved_secret", input);
}

/** 저장된 값을 그대로 돌려주는 유일한 명령. 눈 아이콘만 부르며 호스트 화면 전용이다. */
export function readSavedSecretValue(input: { name: string }): Promise<SavedSecretValueView> {
  return call<SavedSecretValueView>("read_saved_secret_value", input);
}
