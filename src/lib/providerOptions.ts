import { useCallback, useEffect, useSyncExternalStore } from "react";
import { cachedProviderOptions, refreshProviderOptions, subscribeProviderOptions } from "./providerOptionsStore.ts";
import type {
  ChatProviderOptions,
  ChatReasoningOption,
  ProviderId,
} from "../types";

/**
 * 화면이 실행설정 카탈로그를 읽는 방법 — 구독해 다시 그리는 훅과, 고른 모델의 추론 강도
 * 선택지를 꺼내는 규칙.
 *
 * 카탈로그를 들고 있는 싱글턴(공급자 한 칸·요청 합치기·갱신 알림)은
 * `providerOptionsStore`에 있다. 화면은 저장소와 훅을 한 자리에서 가져오므로, 가져오는
 * 자리를 흩지 않도록 저장소의 이름 셋은 여기서 그대로 다시 내보낸다.
 */
export {
  refreshProviderOptions,
  cachedProviderOptions,
  subscribeProviderOptions,
} from "./providerOptionsStore.ts";

export function useProviderOptions(source: ProviderId): ChatProviderOptions | null {
  // 캐시가 돌려주는 객체는 갱신될 때만 새로 담기므로 스냅샷 신원이 안정적이다.
  // 손으로 짠 구독 상태 대신 스토어를 그대로 읽어, 캐시를 읽는 자리를 하나로 둔다.
  // 클라이언트·서버 스냅샷에 같은 화살표 함수를 각각 적어 두면 한쪽만 다른 공급자를 읽는
  // 갈래가 열리므로, 읽기는 한 번만 적고 두 자리에 같은 것을 넘긴다.
  const readCachedOptions = useCallback(() => cachedProviderOptions(source), [source]);
  const options = useSyncExternalStore(subscribeProviderOptions, readCachedOptions, readCachedOptions);

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
