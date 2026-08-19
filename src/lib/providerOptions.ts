import { useEffect, useState } from "react";
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

export function useProviderOptions(source: ProviderId): ChatProviderOptions | null {
  const [options, setOptions] = useState<ChatProviderOptions | null>(() => providerOptionsCache.get(source) ?? null);

  useEffect(() => {
    setOptions(providerOptionsCache.get(source) ?? null);
    const listener = () => setOptions(providerOptionsCache.get(source) ?? null);
    providerOptionsListeners.add(listener);
    // 화면이 처음 열리거나 공급자가 바뀌면 저장된 최신 실행설정 스키마를 읽는다.
    // 여러 화면이 동시에 요청해도 refreshProviderOptions가 공급자별 한 번으로 합친다.
    void refreshProviderOptions(source).catch(() => undefined);
    return () => { providerOptionsListeners.delete(listener); };
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
