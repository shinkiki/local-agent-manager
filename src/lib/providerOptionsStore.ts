import { getChatProviderOptions } from "./ipc";
import type { ChatProviderOptions, ProviderId } from "../types";

/**
 * 공급자별 실행설정 카탈로그의 저장소 — 공급자 한 칸, 같은 요청 합치기, 갱신 알림.
 *
 * 화면이 이 카탈로그를 읽는 방법(`providerOptions`의 훅)과 한 파일에 있었지만 둘이 바뀌는
 * 이유는 다르다. 여기 있는 것은 모듈 수명 동안 살아 있는 싱글턴의 불변식이라 CLI 정보
 * 갱신이나 요청 합치기 규칙이 달라질 때 손대고, 훅 쪽은 어느 화면이 언제 읽고 무엇을
 * 다시 그리는가라 렌더 규칙이 달라질 때 손댄다. 훅 하나를 고치러 들어온 사람이 진행 중
 * 요청을 비우는 자리까지 함께 읽을 필요는 없다. 목록과 저장 규칙을 가른
 * `navigationViews`/`navigationPreferences`, 문법과 덩어리 분할을 가른
 * `markdownFences`/`markdownChunks`와 같은 경계다.
 *
 * React를 가져오지 않는 것이 이 경계의 표시다. 저장소가 훅을 알면 요청 합치기를
 * 렌더 주기에 맞춰 고치고 싶어지는데, 이 카탈로그는 화면 밖(`App`의 CLI 정보 갱신)에서도
 * 갱신된다.
 */

/** 공급자 하나의 저장본과 진행 중 요청은 같은 수명주기 상태로 함께 둔다. */
interface ProviderOptionsState {
  options: ChatProviderOptions | null;
  request: Promise<ChatProviderOptions> | null;
}

const providerOptionsStates = new Map<ProviderId, ProviderOptionsState>();
const providerOptionsListeners = new Set<() => void>();

/**
 * 공급자 한 칸. 없으면 만들어 둔다.
 *
 * 같은 지도를 두 모양으로 읽고 있었다 — 요청하는 쪽은 없으면 만드는 이 함수로, 캐시를
 * 읽는 쪽은 `get(source)?.options ?? null`로. 접근 규칙이 둘이면 칸에 값을 하나 더 둘 때
 * 한쪽만 고쳐지고, "아직 읽지 않은 공급자"의 기본값이 두 자리에 각각 적힌다. 칸은 공급자
 * 수만큼만 생기므로 읽기가 칸을 만들어도 쌓이지 않는다.
 */
function providerOptionsState(source: ProviderId): ProviderOptionsState {
  const existing = providerOptionsStates.get(source);
  if (existing) return existing;
  const state: ProviderOptionsState = { options: null, request: null };
  providerOptionsStates.set(source, state);
  return state;
}

function notifyProviderOptionsChanged() {
  for (const listener of providerOptionsListeners) listener();
}

export async function refreshProviderOptions(source: ProviderId): Promise<ChatProviderOptions> {
  const state = providerOptionsState(source);
  if (state.request) return state.request;

  const request = getChatProviderOptions(source)
    .then((options) => {
      state.options = options;
      notifyProviderOptionsChanged();
      return options;
    })
    .finally(() => {
      if (state.request === request) state.request = null;
    });
  state.request = request;
  return request;
}

/** 이미 읽어 둔 실행설정 카탈로그. 새 요청을 만들지 않는다. */
export function cachedProviderOptions(source: ProviderId): ChatProviderOptions | null {
  return providerOptionsState(source).options;
}

/**
 * 실행설정 카탈로그가 갱신될 때마다 알림을 받는다. CLI 정보 갱신이 실행설정 스키마
 * 재조사를 유발하므로, 여러 공급자를 한꺼번에 보는 화면은 이 알림으로 표시를 맞춘다.
 */
export function subscribeProviderOptions(listener: () => void): () => void {
  providerOptionsListeners.add(listener);
  return () => { providerOptionsListeners.delete(listener); };
}
