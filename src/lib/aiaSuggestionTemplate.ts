/**
 * 제안 하나를 조립하는 일과, 그 안에서 문구를 채우는 템플릿 규칙.
 *
 * `aiaSuggestionRules.ts`는 "지금 스냅샷에서 무엇이 후보인가"를 정하는 곳인데, 후보를
 * 눈에 보이는 제안으로 옮기는 일(허용 필드 화이트리스트, 치환, 길이 자르기, 재무장
 * 메타데이터, id·지문)까지 같은 파일에 있었다. 규칙 종류를 하나 더할 때마다 템플릿
 * 필드 목록과 길이 상한을 지나쳐 읽어야 했고, 반대로 문구 규칙을 손볼 때는 종류별
 * 생성기 사이에서 관련 없는 코드를 헤집게 됐다. 두 관심사를 갈라 둔다.
 *
 * 허용 필드 목록이 이 모듈 안에만 있는 것이 요점이다 — 치환과 필드 걸러내기가 같은
 * 집합을 보므로, 템플릿에 없는 이름이 문구로 새거나 반대로 걸러진 필드가 치환에서만
 * 살아남는 일이 생기지 않는다.
 */
import { suggestionFingerprint } from "./aiaFingerprint.ts";
import { finiteNumber } from "./aiaPrimitives.ts";
import type { SuggestionMetadata } from "./aiaSuggestionOrder.ts";
import type { AiaSuggestion, AiaSuggestionDefinition, AiaSuggestionPack } from "./aiaSuggestionTypes.ts";

/** 종류별 생성기가 제안 하나에 실어 보내는 값들. 이 중 허용 필드만 문구 치환에 쓰인다. */
export type SuggestionFields = SuggestionMetadata;

/** 문구 템플릿에서 치환할 수 있는 이름. 그 밖의 이름이 있는 템플릿은 렌더하지 않는다. */
const TEMPLATE_FIELDS = new Set([
  "projectName",
  "projectPath",
  "sessionTitle",
  "providerName",
  "usagePercent",
  "scheduleName",
  "featureName",
  "translationTarget",
  "skillName",
]);

/** 문구별 길이 상한. 제안 카드의 한 줄·두 줄·프롬프트가 각자 감당하는 길이다. */
const TITLE_LIMIT = 80;
const DETAIL_LIMIT = 240;
const PROMPT_LIMIT = 1000;

/**
 * 정의와 대상 하나로 제안을 만든다. 숨김 기록이 알아보는 지문과 재무장 메타데이터가
 * 여기서 함께 붙으므로, 종류별 생성기는 대상·상태 키와 문구 필드만 정하면 된다.
 */
export function makeSuggestion(
  pack: AiaSuggestionPack,
  definition: AiaSuggestionDefinition,
  targetId: string,
  stateKey: string,
  fields: SuggestionFields,
): AiaSuggestion {
  const metadata = {
    ...fields,
    cooldownMinutes: finiteNumber(definition.rearm?.cooldownMinutes) ?? 0,
    afterResolved: definition.rearm?.afterResolved === true,
  };
  const templateFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => TEMPLATE_FIELDS.has(key)),
  ) as SuggestionFields;
  return {
    id: `${pack.packId}:${definition.id}:${targetId}`,
    definitionId: definition.id,
    fingerprint: suggestionFingerprint(pack.packId, definition.id, targetId, stateKey),
    kind: definition.kind,
    severity: definition.severity,
    priority: definition.priority,
    title: boundedTemplate(definition.titleTemplate, templateFields, TITLE_LIMIT),
    detail: boundedTemplate(definition.detailTemplate, templateFields, DETAIL_LIMIT),
    prompt: boundedTemplate(definition.promptTemplate, templateFields, PROMPT_LIMIT),
    packId: pack.packId,
    packDisplayName: pack.displayName,
    source: pack.source ?? "bundled",
    skillKey: pack.skillKey ?? null,
    targetId,
    stateKey,
    metadata,
  };
}

function renderAiaSuggestionTemplate(template: string, fields: SuggestionFields): string | null {
  let valid = true;
  const rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    if (!TEMPLATE_FIELDS.has(name)) {
      valid = false;
      return "";
    }
    // 화이트리스트를 지난 이름이라도 이번 제안이 그 필드를 싣지 않았을 수 있다.
    return String(fields[name] ?? "");
  });
  return valid ? rendered : null;
}

function boundedTemplate(template: string, fields: SuggestionFields, limit: number): string {
  const rendered = renderAiaSuggestionTemplate(template, fields) ?? "";
  if (rendered.length <= limit) return rendered;
  return `${rendered.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
