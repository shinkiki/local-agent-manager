import type {
  ChatModelCatalogOption,
  ProviderId,
  SystemWorkflowSummary,
  WorkflowInputField,
} from "../types";

/**
 * 워크플로 계약이 선언한 입력 한 벌을 다루는 규칙 — 모델 입력의 어휘와 선택지, 폼 문자열과
 * 계약 인자 사이의 왕복, 그리고 비어 있는 필수 입력 찾기.
 *
 * 예약에 묶인 워크플로가 지금 그대로 실행될 수 있는지(`scheduleWorkflow.ts`)와 한 파일에
 * 있던 동안에는, 입력 하나의 형 변환을 손보러 들어와도 승인 버전·카탈로그 호환성·카드
 * 표기까지 함께 스크롤해야 했고 그 반대도 마찬가지였다. 둘은 바뀌는 이유가 다르다 —
 * 이쪽은 계약이 받는 입력의 종류가 늘 때, 저쪽은 예약이 실행을 막는 사유가 늘 때 바뀐다.
 *
 * 의존은 한 방향이다. 여기는 예약을 모르고, 예약 쪽이 이 규칙을 가져다 쓴다.
 */

/**
 * 계약이 선언한 입력 한 벌을 순회할 수 있게 편 모양. 내보내지 않는다 — 호출부는 모두
 * `workflowInputEntries`가 돌려준 값을 바로 다음 함수에 넘기므로 이 이름을 부를 일이 없다.
 */
type WorkflowInputEntries = [string, WorkflowInputField][];

type WorkflowInputChoice = { value: string; label: string };

type WorkflowModelCatalogs = Partial<Record<ProviderId, readonly ChatModelCatalogOption[]>>;

/** 예약 워크플로 계약이 모델 선택으로 해석하는 입력 이름과 공급자. */
const WORKFLOW_MODEL_INPUT_PROVIDERS: Record<string, ProviderId> = {
  claudeModel: "claude",
  codexModel: "codex",
  antigravityModel: "antigravity",
  localModel: "local",
  localModels: "local",
};

/**
 * 값을 여러 개 담는 모델 입력. 로컬만 해당한다 — 사용량 한도가 없어 계정 여력으로 건수를
 * 정할 수 없고, 대신 참여할 모델을 사용자가 직접 고르기 때문이다. 모델 하나당 한 건이다.
 *
 * 값은 쉼표로 이어 붙인 한 문자열로 저장한다. 워크플로 입력이 문자열 한 칸으로 오가는
 * 계약이라 목록만을 위해 그 계약을 넓히지 않는다(백엔드가 두 모양을 모두 읽는다).
 */
const MULTIPLE_MODEL_INPUTS = new Set(["localModels"]);

/** 이 입력이 모델을 여러 개 고르는 칸인지. */
export function workflowModelInputIsMultiple(name: string): boolean {
  return MULTIPLE_MODEL_INPUTS.has(name);
}

/** 페이싱 계약에서 공급자 모델 ID를 받는 예약 입력 이름. */
export function workflowModelInputProvider(name: string): ProviderId | null {
  return WORKFLOW_MODEL_INPUT_PROVIDERS[name] ?? null;
}

/**
 * 이 입력 이름이 고르게 하는 모델 목록. 모델 입력이 아니면 null이고, 아직 못 읽은
 * 공급자는 빈 목록이다 — 선택지 만들기와 저장 전 검사가 같은 목록을 봐야 "목록에
 * 없는 값"이라는 판정이 화면과 어긋나지 않는다.
 */
function workflowModelCatalog(
  name: string,
  catalogs: WorkflowModelCatalogs,
): readonly ChatModelCatalogOption[] | null {
  const provider = workflowModelInputProvider(name);
  return provider ? catalogs[provider] ?? [] : null;
}

/** 모델 선택지의 표시 라벨 조립. 표시명이 모델 ID와 같으면 중복 표기 없이 ID만 남긴다. */
function formatModelOptionLabel(option: ChatModelCatalogOption): string {
  return option.displayName === option.model
    ? option.model
    : `${option.displayName} · ${option.model}`;
}

/** 모델 표시명과 실제 저장 ID를 함께 보여 주는 select 선택지. */
export function workflowModelInputChoices(
  name: string,
  catalogs: WorkflowModelCatalogs,
): WorkflowInputChoice[] | null {
  const catalog = workflowModelCatalog(name, catalogs);
  if (!catalog) return null;
  return catalog.map((option) => ({
    value: option.model,
    label: formatModelOptionLabel(option),
  }));
}

/** 표시명·공백·폐기된 ID가 모델 인자로 저장되기 전에 목록 선택을 강제한다. */
export function validateWorkflowModelInputs(
  schema: WorkflowInputEntries,
  inputs: Record<string, string>,
  catalogs: WorkflowModelCatalogs,
): string[] {
  const problems: string[] = [];
  for (const [name, field] of schema) {
    const catalog = workflowModelCatalog(name, catalogs);
    const value = inputs[name] ?? "";
    if (!catalog || !value.trim()) continue;
    if (!catalog.some((option) => option.model === value)) {
      problems.push(`모델 목록에서 다시 선택하세요: ${field.label?.trim() || name}.`);
    }
  }
  return problems;
}

/** 계약이 선언한 입력 필드. 없거나 아직 못 읽은 워크플로는 빈 목록이다. */
export function workflowInputEntries(
  workflow: SystemWorkflowSummary | null | undefined,
): WorkflowInputEntries {
  return Object.entries(workflow?.inputSchema ?? {});
}

/**
 * 폼 문자열 값을 계약이 선언한 형으로 바꾼다. 필수가 아닌 빈 값은 생략을 뜻하는 undefined를
 * 반환해 결과 인자에서 제외되도록 한다.
 */
function parseWorkflowInputValue(field: WorkflowInputField, raw: string): unknown | undefined {
  if (field.type === "boolean") {
    if (raw === "" && !field.required) return undefined;
    return raw === "true";
  }
  if (raw.trim() === "") {
    return field.required ? raw : undefined;
  }
  return field.type === "number" ? Number(raw) : raw;
}

/**
 * 스키마 필드를 순회하며 추출자가 돌려준 값만 이름별로 모은다. 인자 만들기와 폼 값 복원이
 * 같은 순회와 빈 값 제외를 각자 적으면, 한쪽만 계약에서 사라진 값을 남기는 식으로 규칙이
 * 갈릴 수 있으므로 어떤 값으로 바꿀지만 호출부가 정한다.
 */
function collectWorkflowValues<T>(
  schema: WorkflowInputEntries,
  resolve: (name: string, field: WorkflowInputField) => T | null | undefined,
): Record<string, T> {
  const values: Record<string, T> = {};
  for (const [name, field] of schema) {
    const value = resolve(name, field);
    if (value === undefined || value === null) continue;
    values[name] = value;
  }
  return values;
}

/**
 * 폼은 값을 문자열로 들고 있으므로 계약이 선언한 형으로 되돌린다. 필수가 아닌 빈 값은
 * 보내지 않아 워크플로가 선언한 기본 동작을 그대로 쓰게 한다.
 */
export function buildWorkflowArguments(
  schema: WorkflowInputEntries,
  inputs: Record<string, string>,
): Record<string, unknown> {
  return collectWorkflowValues(schema, (name, field) => (
    parseWorkflowInputValue(field, inputs[name] ?? "")
  ));
}

/** 저장된 계약 인자 값을 폼 입력 문자열로 직렬화한다. */
function formatWorkflowInputValue(field: WorkflowInputField, value: unknown): string {
  return field.type === "boolean" ? String(value === true) : String(value);
}

/**
 * 스키마 필드를 순회하며 추출자(resolve)가 반환한 값을 폼 입력 문자열로 직렬화한다.
 * 계약에 선언되지 않았거나 값이 비어 있는(undefined/null) 항목은 건너뛴다.
 */
function extractWorkflowInputs(
  schema: WorkflowInputEntries,
  resolve: (name: string, field: WorkflowInputField) => unknown,
): Record<string, string> {
  return collectWorkflowValues(schema, (name, field) => {
    const value = resolve(name, field);
    return value === undefined || value === null
      ? undefined
      : formatWorkflowInputValue(field, value);
  });
}

/**
 * 저장된 인자를 폼이 쓰는 문자열 값으로 되돌린다. 계약에서 사라진 이름은 버려서, 수정
 * 화면이 지금 계약에 없는 입력을 다시 저장하지 않게 한다.
 */
export function workflowInputsFromArguments(
  schema: WorkflowInputEntries,
  args: Record<string, unknown> | null | undefined,
): Record<string, string> {
  return extractWorkflowInputs(schema, (name) => args?.[name]);
}

/**
 * 계약이 선언한 기본값을 폼 값으로 되돌린다. 값이 매번 같은 워크플로는 상세를 열자마자
 * 실행할 수 있어야 하므로, 화면은 빈 폼이 아니라 이 값에서 시작한다. 기본값이 없는
 * 입력은 빈 칸으로 남겨 무엇을 채워야 하는지 그대로 보이게 한다.
 */
export function workflowInputDefaults(schema: WorkflowInputEntries): Record<string, string> {
  return extractWorkflowInputs(schema, (_name, field) => field.defaultValue);
}

/** 불리언이 아닌 필수 입력의 값이 비어 있어 실행을 막아야 하는지 판정한다. */
function isRequiredInputMissing(field: WorkflowInputField, raw: string | undefined): boolean {
  return Boolean(field.required && field.type !== "boolean" && !(raw ?? "").trim());
}

/** 스키마에서 값이 비어 있는 필수 입력 필드 이름 목록을 추출한다. */
export function missingRequiredInputNames(
  schema: WorkflowInputEntries,
  inputs: Record<string, string>,
): string[] {
  return schema
    .filter(([name, field]) => isRequiredInputMissing(field, inputs[name]))
    .map(([name]) => name);
}
