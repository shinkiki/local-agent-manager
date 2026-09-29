import type { ProviderId } from "../types";

/**
 * AIA에게 실행설정 재조사를 시키는 요청문 한 벌.
 *
 * 요청문은 AIA가 어떤 도구를 어떤 순서로 부르고 무엇을 제안해도 되는지를 산문으로 적은
 * 계약이라, 백엔드 자동 조사 범위가 바뀔 때마다 문장을 손본다. 그 문장이 요청을 언제 다시
 * 보낼지 정하는 기록 규칙(`schemaDiscovery.ts`)과 한 파일에 있던 동안에는, 문구 한 줄을
 * 고치러 들어와도 저장 기록의 상한과 형식 검사를 함께 스크롤해야 했다.
 */

/** 대상 공급자 머리말과 요청별 지시문을 같은 줄바꿈 규칙으로 조립한다. */
function providerPrompt(
  title: string,
  sources: readonly ProviderId[],
  instructions: readonly string[],
): string {
  return [
    `${title} 대상 공급자: ${sources.join(", ")}.`,
    ...instructions,
  ].join("\n");
}

/**
 * AIA에게 보내는 실행설정 재조사 요청문.
 *
 * 백엔드는 CLI 정보가 갱신될 때마다 `--help`를 직접 읽어 미지원 선택지를 걸러내고
 * `--effort` 허용값도 읽어 둔다. 도움말이 산문으로만 설명하는 부분(모델 alias 등)은
 * 자동 조사가 못 읽으므로, 그 차이를 메우는 것이 이 요청의 목적이다.
 */
export function schemaDiscoveryPrompt(sources: ProviderId[]): string {
  return providerPrompt("실행설정 재조사 요청입니다.", sources, [
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
  ]);
}

/** 제안한 모델·추론 카탈로그를 지워 CLI 조사 결과와 내장 목록으로 되돌리는 요청문. */
export function catalogResetPrompt(sources: ProviderId[]): string {
  return providerPrompt("모델·추론 카탈로그 제안 제거 요청입니다.", sources, [
    "각 공급자에 대해 propose_chat_settings_schema를 models: [], reasoningEfforts: [] 로 호출해 주세요.",
    "fields는 넘기지 마세요. 실행설정 항목 제안과 자동 조사 결과는 그대로 두어야 합니다.",
    "제거 후 get_chat_provider_options로 결과를 확인하고 요약해 주세요.",
  ]);
}
