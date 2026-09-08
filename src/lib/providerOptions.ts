import { useEffect, useSyncExternalStore } from "react";
import { getChatProviderOptions } from "./ipc";
import type {
  ChatProviderOptions,
  ChatReasoningOption,
  ProviderId,
} from "../types";

const providerOptionsCache = new Map<ProviderId, ChatProviderOptions>();
const providerOptionsRequests = new Map<ProviderId, Promise<ChatProviderOptions>>();
const providerOptionsListeners = new Set<() => void>();

function notifyProviderOptionsChanged() {
  for (const listener of providerOptionsListeners) listener();
}

export async function refreshProviderOptions(source: ProviderId): Promise<ChatProviderOptions> {
  const activeRequest = providerOptionsRequests.get(source);
  if (activeRequest) return activeRequest;

  const request = getChatProviderOptions(source)
    .then((options) => {
      providerOptionsCache.set(source, options);
      notifyProviderOptionsChanged();
      return options;
    })
    .finally(() => {
      if (providerOptionsRequests.get(source) === request) {
        providerOptionsRequests.delete(source);
      }
    });
  providerOptionsRequests.set(source, request);
  return request;
}

/** 이미 읽어 둔 실행설정 카탈로그. 새 요청을 만들지 않는다. */
export function cachedProviderOptions(source: ProviderId): ChatProviderOptions | null {
  return providerOptionsCache.get(source) ?? null;
}

/**
 * 실행설정 카탈로그가 갱신될 때마다 알림을 받는다. CLI 정보 갱신이 실행설정 스키마
 * 재조사를 유발하므로, 여러 공급자를 한꺼번에 보는 화면은 이 알림으로 표시를 맞춘다.
 */
export function subscribeProviderOptions(listener: () => void): () => void {
  providerOptionsListeners.add(listener);
  return () => { providerOptionsListeners.delete(listener); };
}

export function useProviderOptions(source: ProviderId): ChatProviderOptions | null {
  // 캐시가 돌려주는 객체는 갱신될 때만 새로 담기므로 스냅샷 신원이 안정적이다.
  // 손으로 짠 구독 상태 대신 스토어를 그대로 읽어, 캐시를 읽는 자리를 하나로 둔다.
  const options = useSyncExternalStore(
    subscribeProviderOptions,
    () => cachedProviderOptions(source),
    () => cachedProviderOptions(source),
  );

  useEffect(() => {
    // 화면이 처음 열리거나 공급자가 바뀌면 저장된 최신 실행설정 스키마를 읽는다.
    // 여러 화면이 동시에 요청해도 refreshProviderOptions가 공급자별 한 번으로 합친다.
    void refreshProviderOptions(source).catch(() => undefined);
  }, [source]);

  return options?.source === source ? options : null;
}

export function reasoningOptionsFor(catalog: ChatProviderOptions | null, model: string): ChatReasoningOption[] {
  if (!catalog) return [];
  const selected = model
    ? catalog.models.find((option) => option.model === model)
    : catalog.models.find((option) => option.isDefault);
  return selected?.supportedReasoningEfforts.length
    ? selected.supportedReasoningEfforts
    : catalog.supportedReasoningEfforts;
}
