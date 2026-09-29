import type { ChatProviderOptions } from "../types";

/**
 * 실행설정 재조사를 언제 다시 물을지 정하는 기록. 무엇을 묻는지(요청문)는
 * `schemaDiscoveryPrompts.ts`가 맡고, 이 파일은 그 요청을 CLI 버전당 한 번만 보내도록
 * 키를 만들고 저장된 기록을 읽고 쓰는 일만 다룬다.
 *
 * 요청문을 이미 이 이름으로 가져다 쓰는 화면이 있어, 두 요청문은 여기서 다시 내보낸다.
 */

export { catalogResetPrompt, schemaDiscoveryPrompt } from "./schemaDiscoveryPrompts.ts";

/**
 * 재조사 요청을 CLI 버전당 한 번만 보내기 위한 키. AIA가 실패하거나 사용자가 창을
 * 닫아도 같은 버전에서 다시 조르지 않고, CLI가 업데이트되면 키가 바뀌어 다시 묻는다.
 */
export function discoveryRequestKey(options: ChatProviderOptions): string {
  return `${options.source}:${options.cliVersion ?? ""}`;
}

/** 보낸 요청 기록의 상한. 공급자 수 × CLI 버전 몇 세대면 충분하고 오래된 것부터 버린다. */
const MAX_DISCOVERY_REQUESTS = 24;

/** 요청 기록은 어느 경로에서 갱신해도 최신 항목만 같은 상한으로 남긴다. */
function limitDiscoveryRequests(requests: readonly string[]): string[] {
  return requests.slice(-MAX_DISCOVERY_REQUESTS);
}

/**
 * 저장된 요청 기록을 읽는다. 기록은 창을 다시 열거나 팝아웃 창에서 봐도 이어져야 하므로
 * 메모리가 아니라 저장소에 둔다. 형식이 깨졌으면 기록이 없는 것으로 보고 다시 묻는다.
 */
export function parseDiscoveryRequests(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return limitDiscoveryRequests(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return [];
  }
}

/** 방금 보낸 요청 키를 기록에 더한다. 중복은 최신 위치로 모으고 상한을 넘으면 앞에서 버린다. */
export function rememberDiscoveryRequests(current: string[], added: string[]): string[] {
  const addedKeys = new Set(added);
  const next = current.filter((key) => !addedKeys.has(key));
  next.push(...addedKeys);
  return limitDiscoveryRequests(next);
}

/** 모델·추론 카탈로그가 오래되어 AIA 재조사가 필요한 공급자. */
export function staleCatalogSources(options: (ChatProviderOptions | null)[]): ChatProviderOptions[] {
  return options.filter((item): item is ChatProviderOptions => Boolean(item?.catalogStale));
}
