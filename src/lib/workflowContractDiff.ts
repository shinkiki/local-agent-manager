import type { SystemWorkflowContract } from "../types.ts";

/**
 * 두 계약 버전 사이의 차이.
 *
 * 줄 단위 비교(`textDiff`)만 보여 주면 "무엇이 달라졌는지"를 사람이 JSON에서 읽어 내야 한다.
 * 버전을 올린 이유는 대개 단계·입력·스킬·위험도 중 하나이므로, 그 네 가지를 먼저 한 줄로
 * 말하고 원문 비교는 그 근거로 아래에 둔다.
 */
interface WorkflowContractChanges {
  steps: KeyedChanges;
  inputs: KeyedChanges;
  skills: { added: string[]; removed: string[] };
  riskChanged: boolean;
  runtimeChanged: boolean;
  pacedChanged: boolean;
  /** 네 갈래 어디에도 잡히지 않는 차이(표시 이름·설명 등)까지 포함해 다른 곳이 있는지. */
  identical: boolean;
}

/** 키로 짝지어 비교한 한 축의 차이. 키는 언제나 나중 쪽(추가·변경)·이전 쪽(삭제)의 순서다. */
interface KeyedChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * 키가 있는 두 벌을 견준다. 단계는 `id`를 가진 배열이고 입력은 이름을 키로 가진 레코드라
 * 그릇은 다르지만, 달라진 것을 말하는 방법은 같다 — 나중에만 있으면 추가, 이전에만 있으면
 * 삭제, 양쪽에 있고 값이 다르면 변경. 축마다 이 셋을 따로 적으면 한 축의 판정만 고쳐도
 * 같은 화면의 다른 줄이 다른 기준으로 달라졌다고 말하게 된다.
 */
function keyedChanges(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): KeyedChanges {
  const added: string[] = [];
  const changed: string[] = [];
  for (const [key, value] of after) {
    if (!before.has(key)) added.push(key);
    else if (!sameValue(before.get(key), value)) changed.push(key);
  }
  return { added, removed: [...before.keys()].filter((key) => !after.has(key)), changed };
}

function stepsById(contract: SystemWorkflowContract): Map<string, unknown> {
  return new Map(contract.steps.map((step) => [step.id, step]));
}

function inputsByName(contract: SystemWorkflowContract): Map<string, unknown> {
  return new Map(Object.entries(contract.inputSchema ?? {}));
}

/**
 * 이전과 이후의 스킬 목록에서 추가·삭제된 스킬을 가른다. 스킬은 이름 목록이라 짝지을 키가 곧
 * 값이고, 그래서 "값이 달라진" 갈래가 없다. 목록을 그대로 견주므로 같은 스킬이 두 번 적힌
 * 계약도 적힌 그대로 나온다.
 */
function skillChanges(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((skill) => !beforeSet.has(skill)),
    removed: before.filter((skill) => !afterSet.has(skill)),
  };
}

export function workflowContractChanges(
  before: SystemWorkflowContract,
  after: SystemWorkflowContract,
): WorkflowContractChanges {
  return {
    steps: keyedChanges(stepsById(before), stepsById(after)),
    inputs: keyedChanges(inputsByName(before), inputsByName(after)),
    skills: skillChanges(before.requiredSkills ?? [], after.requiredSkills ?? []),
    riskChanged: before.risk !== after.risk,
    runtimeChanged: !sameValue(before.chatRuntime ?? null, after.chatRuntime ?? null),
    pacedChanged: Boolean(before.paced) !== Boolean(after.paced),
    identical: contractText(before) === contractText(after),
  };
}

/**
 * 비교에 쓰는 계약 원문. 키를 정렬해 저장 순서가 달라졌다는 이유로 차이가 생기지 않게 하고,
 * 버전 번호는 뺀다 — 두 버전은 정의상 번호가 다르므로 그 줄은 언제나 차이로 잡혀 실제
 * 변경을 가린다.
 */
export function contractText(contract: SystemWorkflowContract): string {
  const { version: _version, ...rest } = contract;
  return `${stableJson(rest, 2)}\n`;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return stableJson(left) === stableJson(right);
}

/** 객체 키 순서와 무관한 계약 비교·표시용 JSON. */
function stableJson(value: unknown, space?: number): string | undefined {
  return JSON.stringify(sortKeys(value), null, space);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]));
}
