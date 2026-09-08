import type { ChatProviderOptions, ProviderId } from "../types";
import { uniqueInOrder } from "./sequence.ts";

/**
 * AIA에게 보내는 실행설정 재조사 요청문.
 *
 * 백엔드는 CLI 정보가 갱신될 때마다 `--help`를 직접 읽어 미지원 선택지를 걸러내고
 * `--effort` 허용값도 읽어 둔다. 도움말이 산문으로만 설명하는 부분(모델 alias 등)은
 * 자동 조사가 못 읽으므로, 그 차이를 메우는 것이 이 요청의 목적이다.
 */
export function schemaDiscoveryPrompt(sources: ProviderId[]): string {
  return [
    `실행설정 재조사 요청입니다. 대상 공급자: ${sources.join(", ")}.`,
    "백엔드는 CLI 정보가 갱신될 때마다 `--help`를 직접 읽어 지원하지 않는 선택지를 걸러내고,",
    "`--effort`처럼 허용값 목록이 도움말에 나오는 항목은 이미 반영해 둡니다.",
    "먼저 get_chat_provider_options로 공급자별 현재 스키마와 모델·추론 목록을 확인한 뒤,",
    "설치된 CLI 인터페이스를 직접 조사해 주세요 (예: `claude --help`, `codex --help`, `codex exec --help`).",
    "그다음 자동 조사가 놓친 차이만 propose_chat_settings_schema로 제안해 주세요.",
    "- fields: 내장 항목은 선택지 재구성만, 새 항목은 화이트리스트 범위에서만 추가할 수 있습니다.",
    "  생략하면 기존 제안을 유지하고, 빈 배열로 보내면 fields 제안만 제거합니다.",
    "- models: CLI가 모델 목록을 직접 내보내지 않는 공급자만 채웁니다. 도움말 산문에 있는 alias와",
    "  정식 모델명을 모두 담고, 표시명은 공급자 표기를 그대로 씁니다. 기본 모델은 하나만 지정합니다.",
    "- reasoningEfforts: 도움말에 없는 새 수준까지 확인되면 이름과 짧은 한국어 설명을 함께 담습니다.",
    "확인하지 못한 항목은 넘기지 말고 그대로 두세요(생략하면 기존 제안이 유지됩니다).",
    "완료 후 변경 내역을 요약해 주세요.",
  ].join("\n");
}

/** 제안한 모델·추론 카탈로그를 지워 CLI 조사 결과와 내장 목록으로 되돌리는 요청문. */
export function catalogResetPrompt(sources: ProviderId[]): string {
  return [
    `모델·추론 카탈로그 제안 제거 요청입니다. 대상 공급자: ${sources.join(", ")}.`,
    "각 공급자에 대해 propose_chat_settings_schema를 models: [], reasoningEfforts: [] 로 호출해 주세요.",
    "fields는 넘기지 마세요. 실행설정 항목 제안과 자동 조사 결과는 그대로 두어야 합니다.",
    "제거 후 get_chat_provider_options로 결과를 확인하고 요약해 주세요.",
  ].join("\n");
}

/**
 * 재조사 요청을 CLI 버전당 한 번만 보내기 위한 키. AIA가 실패하거나 사용자가 창을
 * 닫아도 같은 버전에서 다시 조르지 않고, CLI가 업데이트되면 키가 바뀌어 다시 묻는다.
 */
export function discoveryRequestKey(options: ChatProviderOptions): string {
  return `${options.source}:${options.cliVersion ?? ""}`;
}

/** 보낸 요청 기록의 상한. 공급자 수 × CLI 버전 몇 세대면 충분하고 오래된 것부터 버린다. */
const MAX_DISCOVERY_REQUESTS = 24;

/**
 * 저장된 요청 기록을 읽는다. 기록은 창을 다시 열거나 팝아웃 창에서 봐도 이어져야 하므로
 * 메모리가 아니라 저장소에 둔다. 형식이 깨졌으면 기록이 없는 것으로 보고 다시 묻는다.
 */
export function parseDiscoveryRequests(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(-MAX_DISCOVERY_REQUESTS);
  } catch {
    return [];
  }
}

/** 방금 보낸 요청 키를 기록에 더한다. 중복은 최신 위치로 모으고 상한을 넘으면 앞에서 버린다. */
export function rememberDiscoveryRequests(current: string[], added: string[]): string[] {
  const next = current.filter((key) => !added.includes(key));
  next.push(...uniqueInOrder(added));
  return next.slice(-MAX_DISCOVERY_REQUESTS);
}

/** 모델·추론 카탈로그가 오래되어 AIA 재조사가 필요한 공급자. */
export function staleCatalogSources(options: (ChatProviderOptions | null)[]): ChatProviderOptions[] {
  return options.filter((item): item is ChatProviderOptions => Boolean(item?.catalogStale));
}
