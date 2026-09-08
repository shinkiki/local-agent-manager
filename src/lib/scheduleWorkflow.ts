import type {
  ChatModelCatalogOption,
  ProviderId,
  ScheduleWorkflowBinding,
  SystemWorkflowSummary,
  WorkflowInputField,
} from "../types";

export type WorkflowInputEntries = [string, WorkflowInputField][];

export type WorkflowInputChoice = { value: string; label: string };

export type WorkflowModelCatalogs = Partial<Record<ProviderId, readonly ChatModelCatalogOption[]>>;

/** 예약 워크플로 계약이 모델 선택으로 해석하는 입력 이름과 공급자. */
const WORKFLOW_MODEL_INPUT_PROVIDERS = {
  claudeModel: "claude",
  codexModel: "codex",
  antigravityModel: "antigravity",
} as const satisfies Record<string, ProviderId>;

/** 페이싱 계약에서 공급자 모델 ID를 받는 예약 입력 이름. */
export function workflowModelInputProvider(name: string): ProviderId | null {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_MODEL_INPUT_PROVIDERS, name)
    ? WORKFLOW_MODEL_INPUT_PROVIDERS[name as keyof typeof WORKFLOW_MODEL_INPUT_PROVIDERS]
    : null;
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

/** 모델 표시명과 실제 저장 ID를 함께 보여 주는 select 선택지. */
export function workflowModelInputChoices(
  name: string,
  catalogs: WorkflowModelCatalogs,
): WorkflowInputChoice[] | null {
  const catalog = workflowModelCatalog(name, catalogs);
  if (!catalog) return null;
  return catalog.map((option) => ({
    value: option.model,
    label: option.displayName === option.model
      ? option.model
      : `${option.displayName} · ${option.model}`,
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
 * 폼은 값을 문자열로 들고 있으므로 계약이 선언한 형으로 되돌린다. 필수가 아닌 빈 값은
 * 보내지 않아 워크플로가 선언한 기본 동작을 그대로 쓰게 한다.
 */
export function buildWorkflowArguments(
  schema: WorkflowInputEntries,
  inputs: Record<string, string>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, field] of schema) {
    const raw = inputs[name] ?? "";
    if (field.type === "boolean") {
      if (raw === "" && !field.required) continue;
      args[name] = raw === "true";
      continue;
    }
    if (raw.trim() === "") {
      if (!field.required) continue;
      args[name] = raw;
      continue;
    }
    args[name] = field.type === "number" ? Number(raw) : raw;
  }
  return args;
}

/**
 * 저장된 인자를 폼이 쓰는 문자열 값으로 되돌린다. 계약에서 사라진 이름은 버려서, 수정
 * 화면이 지금 계약에 없는 입력을 다시 저장하지 않게 한다.
 */
export function workflowInputsFromArguments(
  schema: WorkflowInputEntries,
  args: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const [name, field] of schema) {
    const value = args?.[name];
    if (value === undefined || value === null) continue;
    inputs[name] = field.type === "boolean" ? String(value === true) : String(value);
  }
  return inputs;
}

/**
 * 계약이 선언한 기본값을 폼 값으로 되돌린다. 값이 매번 같은 워크플로는 상세를 열자마자
 * 실행할 수 있어야 하므로, 화면은 빈 폼이 아니라 이 값에서 시작한다. 기본값이 없는
 * 입력은 빈 칸으로 남겨 무엇을 채워야 하는지 그대로 보이게 한다.
 */
export function workflowInputDefaults(schema: WorkflowInputEntries): Record<string, string> {
  const defaults: Record<string, unknown> = {};
  for (const [name, field] of schema) {
    if (field.defaultValue === undefined || field.defaultValue === null) continue;
    defaults[name] = field.defaultValue;
  }
  return workflowInputsFromArguments(schema, defaults);
}

/**
 * 저장 전에 화면에서 막을 수 있는 문제를 모은다. 승인 버전과 카탈로그 호환성은 백엔드가
 * 다시 확인하지만, 저장 버튼을 누르고 나서야 알려 주면 사용자가 무엇을 고쳐야 하는지
 * 알기 어렵다.
 */
export function validateScheduleWorkflowDraft(draft: {
  workflow: SystemWorkflowSummary | null | undefined;
  inputs: Record<string, string>;
}): string[] {
  const problems: string[] = [];
  const workflow = draft.workflow;
  if (!workflow) return ["실행할 워크플로를 선택하세요."];
  if (typeof workflow.version !== "number" || workflow.version <= 0) {
    problems.push("워크플로 승인 버전을 확인할 수 없습니다.");
  }
  if (!workflow.compatible) {
    problems.push("현재 카탈로그와 호환되지 않는 워크플로입니다. AIA가 다시 등록해야 합니다.");
  }
  const missing = workflowInputEntries(workflow)
    .filter(([name, field]) => field.required && field.type !== "boolean" && !(draft.inputs[name] ?? "").trim())
    .map(([name]) => name);
  if (missing.length > 0) problems.push(`필수 입력이 비어 있습니다: ${missing.join(", ")}`);
  return problems;
}

/**
 * 카드 한 줄에 넣을 워크플로 표기. 등록 버전이 승인 버전과 달라지면 다음 회차가 실행되지
 * 않고 멈추므로, 목록에서 바로 재승인이 필요한 것을 알 수 있게 함께 적는다.
 */
export function describeScheduleWorkflow(
  binding: ScheduleWorkflowBinding,
  workflows: SystemWorkflowSummary[],
): string {
  const known = workflows.find((workflow) => workflow.id === binding.workflowId);
  const head = `워크플로 ${known?.displayName ?? binding.workflowId} v${binding.approvedVersion}`;
  const blocker = scheduleWorkflowBlocker(binding, known);
  return blocker ? `${head} · ${blocker}` : head;
}

/**
 * 등록된 워크플로가 이 묶음을 지금 그대로 실행하지 못하게 막는 사유. 막을 것이 없으면
 * null이다. 표기 앞머리와 함께 적혀 있던 때에는 사유를 하나 늘릴 때마다 같은 앞머리를
 * 한 번 더 적어야 했고, 그중 하나만 다르게 적혀도 카드마다 표기가 어긋났다.
 */
function scheduleWorkflowBlocker(
  binding: ScheduleWorkflowBinding,
  known: SystemWorkflowSummary | undefined,
): string | null {
  if (!known) return "목록에 없음";
  if (known.version !== binding.approvedVersion) return `재승인 필요(현재 v${known.version ?? "?"})`;
  if (!known.compatible) return "카탈로그 비호환";
  return null;
}
