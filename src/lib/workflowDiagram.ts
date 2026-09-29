import { runtimeText } from "./i18nRuntime.ts";
import { workflowDiagramPaletteLines } from "./workflowDiagramPalette.ts";
import type { SystemWorkflowContract, SystemWorkflowStep } from "../types.ts";

/**
 * 색표는 `workflowDiagramPalette`가 소유한다. 그림과 범례는 함께 하나의 기능이므로 쓰는
 * 쪽이 보는 입구는 이 모듈 하나로 둔다 — 나눈 쪽의 사정이 컴포넌트의 import 목록으로 새어
 * 나가면 다음에 다시 나눌 때마다 컴포넌트를 함께 고쳐야 한다.
 */
export { workflowDiagramPalette } from "./workflowDiagramPalette.ts";

/**
 * 워크플로 계약 한 벌을 mermaid 흐름도 원문으로 옮긴다.
 *
 * 계약이 완전한 선언형이라 이 변환은 백엔드를 부르지 않는다 — 같은 계약과 같은 화면 언어는
 * 언제나 같은 그림이다. 화면은 이 문자열을 `DiagramViewer`에 그대로 넘긴다.
 *
 * 우리가 짓는 라벨(봉투·제어 조건·스킬)은 `runtimeText`로 지금 화면 언어를 따른다. 그래서
 * 부르는 쪽은 언어를 바꿀 때 다시 불러야 한다 — 모듈 적재 시점에 굳히지 않는 이유도 같다.
 *
 * 그리는 것은 **계약이 실제로 보장하는 것**뿐이다. 단계는 선언된 순서대로 돌고, 앞 단계가
 * 실패하면 거기서 멈추며, `forEach`는 상한이 있는 반복이고, `$step`은 앞 단계의 결과를
 * 읽는다. 추측한 분기나 계약에 없는 병렬은 그리지 않는다.
 *
 * 페이싱 회차 계약(`paced`)은 계약 단계만 그리면 상자 한 개짜리 그림이 된다 — 실제 절차의
 * 대부분이 계약 바깥, 스케줄러의 회차 봉투에 있기 때문이다. 그래서 봉투를 함께 그리되
 * 계약이 소유한 부분과 눈으로 구분되게 둔다.
 */
export function workflowDiagram(contract: SystemWorkflowContract, options: WorkflowDiagramOptions = {}): string {
  const lines: string[] = ["flowchart TD"];
  const inputs = Object.keys(contract.inputSchema ?? {});
  const skills = skillLines(contract.requiredSkills ?? [], contract.steps, options.skillHref);

  if (contract.paced) lines.push(...envelopeLines());
  lines.push(...contractLines(contract, inputs));
  lines.push(...skills.lines);
  lines.push(...workflowDiagramPaletteLines(options.dark ?? true, contract.paced === true));
  // 클릭은 맨 뒤에 모은다. mermaid는 `click`을 상자 선언 뒤에서만 읽는데, 스킬 상자를
  // 그리는 자리에서 바로 붙이면 뒤따르는 classDef·style 사이에 끼어든다.
  lines.push(...skills.clicks);
  return lines.join("\n");
}

interface WorkflowDiagramOptions {
  /** 스킬 상자에 달 주소. 열 수 없으면 `null`을 주면 상자에 클릭이 붙지 않는다. */
  skillHref?: (skill: string) => string | null;
  /**
   * 지금 화면이 어두운 테마인지. 상자 색을 여기서 정해야 하는 이유는 엔진이 테마를 두 벌
   * (`dark`·`default`)만 알기 때문이다 — 우리가 칠하는 상자(봉투·스킬·묶음)는 그 테마 밖이라
   * 한쪽 색으로 못박아 두면 반대 테마에서 배경과 같은 계열이 되거나 혼자 밝게 튄다.
   */
  dark?: boolean;
}

/**
 * 원문의 들여쓰기. 묶음(subgraph) 안은 한 단계 더 들어가고, 묶음을 닫은 뒤에 오는 줄
 * (색칠·데이터 의존선)은 바깥 단계다. 조립하는 함수마다 공백을 직접 세고 있으면 줄을
 * 다른 함수로 옮길 때 들여쓰기만 옛 자리의 것으로 남아, 엔진이 그 줄을 묶음의 자식으로
 * 읽거나 반대로 묶음 밖으로 흘린다.
 */
const OUTER_INDENT = "  ";
const SUBGRAPH_INDENT = "    ";

/**
 * 상자 모양별로 라벨을 감싸는 괄호. 모양이 다를 뿐 그 안은 셋 다 같다 — 라벨을 문법에서
 * 안전하게 만들고(`escapeLabel`) 따옴표로 감싼다.
 */
const NODE_SHAPES = {
  box: ['["', '"]'],
  input: ['[/"', '"/]'],
  stadium: ['(["', '"])'],
  gate: ['{{"', '"}}'],
} as const;

/**
 * 상자 한 줄. 네 자리가 이 모양을 각자 적고 있었고, 그중 스킬 상자만 라벨의 일부
 * (`스킬<br/>`)를 escape 밖에 두는 식으로 어긋나 있었다 — 줄바꿈은 `escapeLabel`이
 * 이미 `<br/>`로 옮기므로 그 예외를 둘 이유가 없다. 한 벌로 모으면 새 모양을 더하거나
 * escape 규칙을 고칠 자리가 한 곳뿐이다.
 */
function nodeLine(indent: string, id: string, shape: keyof typeof NODE_SHAPES, label: string): string {
  const [open, close] = NODE_SHAPES[shape];
  return `${indent}${id}${open}${escapeLabel(label)}${close}`;
}

/**
 * 점선 연결. 실행 순서선이 아닌 관계(자기 반복·결과 참조·스킬)는 모두 이 모양으로 긋고
 * 무엇 때문에 이어졌는지를 선 위에 적는다. 세 자리가 따로 적으면 그중 하나만 실선이나
 * 다른 화살표로 바뀌어도 드러나지 않는다.
 */
function dottedEdge(indent: string, from: string, to: string, text: string): string {
  return `${indent}${from} -. "${text}" .-> ${to}`;
}

/**
 * 실행 순서선. 점선(`dottedEdge`)과 달리 선 위에 적을 말이 없어 모양이 전부다. 봉투와
 * 계약이 이 모양을 각자 적고 있었고, 봉투 쪽은 상자 선언과 한 줄에 붙여 두어 화살표를
 * 고치려면 상자 문법까지 함께 읽어야 했다.
 */
function flowEdge(indent: string, from: string, to: string): string {
  return `${indent}${from} --> ${to}`;
}

/**
 * 묶음 한 벌. 머리·방향·닫기 세 줄은 묶음마다 같고 다른 것은 id와 제목, 그리고 안에
 * 담을 줄뿐이다. 두 자리가 따로 적고 있어 봉투 쪽 제목만 `escapeLabel`을 지나지 않았다 —
 * 지금 제목에는 걸릴 글자가 없지만, 그 예외를 남겨 둘 이유도 없다. 안쪽 줄의 들여쓰기가
 * 머리와 같은 자리에서 정해져야 묶음을 옮길 때 한쪽만 옛 단계로 남지 않는다.
 */
function subgraphLines(id: string, title: string, inner: readonly string[]): string[] {
  return [
    `${OUTER_INDENT}subgraph ${id}["${escapeLabel(title)}"]`,
    `${SUBGRAPH_INDENT}direction TB`,
    ...inner,
    `${OUTER_INDENT}end`,
  ];
}

/** 색칠 한 줄. 상자가 여럿이면 쉼표로 잇는다. */
function classLine(nodes: readonly string[], className: string): string {
  return `${OUTER_INDENT}class ${nodes.join(",")} ${className}`;
}

/**
 * 회차 봉투. 사용량 갱신 → 기동 수 계산(예약 기록) → 지난 회차 정리 → 계약 실행 → 재갱신은
 * 스케줄러가 계약 바깥에서 매 회차 수행하는 고정 순서이고, 실제 기동 건수는 예산이 정한다.
 * 계약에는 이 단계들이 없으므로(계산 단계는 어떤 계약에서도 금지) 상자에 단계 id를 달지
 * 않는다 — 계약이 소유하지 않은 것을 계약의 일부처럼 보이게 하지 않기 위해서다.
 */
function envelopeLines(): string[] {
  return [
    ...subgraphLines("wf_envelope", runtimeText("회차 봉투 · 스케줄러가 계약 바깥에서 수행", "Round envelope · run by the scheduler outside the contract"), [
      nodeLine(SUBGRAPH_INDENT, "env_refresh", "box", runtimeText("사용량 갱신", "Refresh usage")),
      nodeLine(SUBGRAPH_INDENT, "env_plan", "box", runtimeText("기동 수 계산 · 예약 기록", "Compute launch count · record the reservation")),
      nodeLine(SUBGRAPH_INDENT, "env_stale", "box", runtimeText("지난 회차 정리", "Clean up the previous round")),
      nodeLine(SUBGRAPH_INDENT, "env_launch", "gate", runtimeText("예산이 정한 건수만큼 기동", "Launch as many as the budget allows")),
      flowEdge(SUBGRAPH_INDENT, "env_refresh", "env_plan"),
      flowEdge(SUBGRAPH_INDENT, "env_plan", "env_stale"),
      flowEdge(SUBGRAPH_INDENT, "env_stale", "env_launch"),
    ]),
    flowEdge(OUTER_INDENT, "env_launch", "contract_entry"),
    nodeLine(OUTER_INDENT, "env_done", "box", runtimeText("사용량 재갱신", "Refresh usage again")),
    classLine(["env_refresh", "env_plan", "env_stale", "env_done"], "envelope"),
    classLine(["env_launch"], "envelopeGate"),
  ];
}

/**
 * 계약이 소유한 부분 — 입력과 단계, 그리고 단계 사이의 순서·데이터 의존.
 *
 * 조립 순서가 곧 원문의 순서다. 묶음 안에는 상자와 순서선만 두고, 색칠(`class`)과
 * 데이터 의존선은 묶음을 닫은 뒤에 온다 — 묶음 안에 두면 엔진이 묶음의 자식으로 읽어
 * 봉투 쪽 상자와 이어진 선이 묶음 경계에서 끊긴다.
 */
function contractLines(contract: SystemWorkflowContract, inputs: string[]): string[] {
  const version = contract.version ? ` v${contract.version}` : "";
  return [
    ...subgraphLines("wf_contract", `${contract.displayName || contract.id} · ${runtimeText("계약", "contract")}${version}`, [
      contractEntryLine(contract, inputs),
      ...stepFlowLines(contract.steps),
    ]),
    ...stepClassLines(contract.steps),
    ...stepReferenceLines(contract.steps),
    ...envelopeReturnLines(contract),
  ];
}

/** 입력 상자. 입력이 하나도 없는 계약도 시작점은 있어야 뒤 단계가 매달릴 자리가 생긴다. */
function contractEntryLine(contract: SystemWorkflowContract, inputs: string[]): string {
  const label = inputs.length === 0 ? runtimeText("입력 없음", "No inputs") : inputLabel(contract, inputs);
  return nodeLine(SUBGRAPH_INDENT, "contract_entry", "input", label);
}

/** 단계 상자와 실행 순서선. `forEach`는 상한이 있는 자기 반복이라 제자리 점선으로 그린다. */
function stepFlowLines(steps: SystemWorkflowStep[]): string[] {
  const lines: string[] = [];
  let previous = "contract_entry";
  for (const [index, step] of steps.entries()) {
    const id = stepNode(index);
    lines.push(nodeLine(SUBGRAPH_INDENT, id, "box", stepLabel(step, index)));
    lines.push(flowEdge(SUBGRAPH_INDENT, previous, id));
    if (step.forEach) {
      lines.push(dottedEdge(SUBGRAPH_INDENT, id, id, runtimeText(`최대 ${step.forEach.maxIterations}회 반복`, `Up to ${step.forEach.maxIterations} iterations`)));
    }
    previous = id;
  }
  return lines;
}

/**
 * 계약이 소유한 상자도 우리가 칠한다. 엔진 기본 상자는 회색 계열이라 앱 화면(네이비)에서
 * 봉투·스킬만 제자리를 찾고 정작 계약 단계가 남의 색으로 남는다.
 */
function stepClassLines(steps: SystemWorkflowStep[]): string[] {
  const lines = [classLine(["contract_entry"], "entry")];
  if (steps.length > 0) {
    lines.push(classLine(steps.map((_, index) => stepNode(index)), "step"));
  }
  return lines;
}

/** 데이터 의존은 순서선과 섞이면 읽을 수 없다. 점선으로 따로 긋고 어떤 값을 읽는지 적는다. */
function stepReferenceLines(steps: SystemWorkflowStep[]): string[] {
  const stepIndexes = firstStepIndexes(steps);
  const lines: string[] = [];
  for (const [index, step] of steps.entries()) {
    for (const source of referencedSteps(step)) {
      const from = stepIndexes.get(source);
      if (from !== undefined && from !== index) {
        lines.push(dottedEdge(OUTER_INDENT, stepNode(from), stepNode(index), runtimeText("결과 참조", "Reads the result")));
      }
    }
  }
  return lines;
}

/**
 * 회차 봉투로 돌아가는 선. 단계가 없는 계약(검증에서는 막지만 옛 저장본에 있을 수 있다)이면
 * 입력 상자에서 잇는다 — 없는 단계 번호로 이으면 `step_-1`이라는 빈 상자가 하나 더 생긴다.
 */
function envelopeReturnLines(contract: SystemWorkflowContract): string[] {
  if (!contract.paced) return [];
  const last = contract.steps.length > 0 ? stepNode(contract.steps.length - 1) : "contract_entry";
  return [flowEdge(OUTER_INDENT, last, "env_done")];
}

/**
 * 단계 id가 처음 선언된 위치. 결과 참조마다 단계 전체를 다시 찾지 않고 계약당 한 번만
 * 만든다. 중복 id가 든 옛 저장본에서도 기존 `findIndex`처럼 첫 선언을 가리킨다.
 */
function firstStepIndexes(steps: SystemWorkflowStep[]): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (!indexes.has(step.id)) indexes.set(step.id, index);
  }
  return indexes;
}

/**
 * 스킬 상자가 만들어 내는 두 갈래 원문. 상자 선언은 그림의 제자리에 들어가지만 `click`은
 * 원문 맨 뒤에만 설 수 있어, 한 목록으로 합쳐 돌려줄 수 없다. 그렇다고 호출부가 넘긴
 * 배열에 담아 주면 "돌려주는 것"과 "채워 주는 것"이 한 함수에 섞여, 읽는 쪽이 클릭이
 * 어디서 생기는지 함수 밖에서 따라가야 한다.
 */
interface SkillDiagramLines {
  lines: string[];
  clicks: string[];
}

/**
 * 계약이 선언한 스킬. 계약은 스킬을 실행하지 않고 무인 런타임에 보내는 지시문이 따르게
 * 하므로, 단계에서 화살표를 긋되 실행 순서선과 같은 실선으로 긋지 않는다.
 *
 * 주소를 넘겨받았을 때만 클릭을 단다. 그림은 원문 하나로 자립해야 하는데(별도 창은 앱의
 * DOM을 보지 못한다) 열 수 없는 주소를 달아 두면 눌러도 아무 일이 없는 상자가 된다.
 */
function skillLines(
  skills: string[],
  steps: SystemWorkflowStep[],
  skillHref?: (skill: string) => string | null,
): SkillDiagramLines {
  if (skills.length === 0) return { lines: [], clicks: [] };
  const lines: string[] = [];
  const clicks: string[] = [];
  // 스킬을 따르는 것은 채팅을 띄우는 단계다. 그런 단계가 없으면 계약 전체에 건다.
  const anchors = steps
    .map((step, index) => (step.operation === "start_chat" ? stepNode(index) : null))
    .filter((node): node is string => node != null);
  for (const [index, skill] of skills.entries()) {
    const item = skillDiagramLines(skill, index, anchors, skillHref?.(skill));
    lines.push(...item.lines);
    clicks.push(...item.clicks);
  }
  return { lines, clicks };
}

/** 스킬 한 건의 상자·연결선과 원문 맨 뒤로 보낼 클릭 선언. */
function skillDiagramLines(
  skill: string,
  index: number,
  chatAnchors: string[],
  href: string | null | undefined,
): SkillDiagramLines {
  const id = `skill_${index}`;
  // 이름과 키를 한 줄에 두면 엔진이 긴 라벨을 스스로 접으면서 사이의 공백이 사라진다.
  // 어디서 접힐지를 우리가 정해 두면 상자의 두 줄이 언제나 같은 모양으로 나온다.
  const lines = [
    nodeLine(OUTER_INDENT, id, "stadium", `${runtimeText("스킬", "Skill")}\n${skill}`),
    classLine([id], "skill"),
    ...(chatAnchors.length > 0 ? chatAnchors : ["contract_entry"])
      .map((anchor) => dottedEdge(OUTER_INDENT, anchor, id, runtimeText("이 절차를 따른다", "Follows this procedure"))),
  ];
  const clicks = href ? [`${OUTER_INDENT}click ${id} href "${escapeLabel(href)}"`] : [];
  return { lines, clicks };
}

function stepNode(index: number): string {
  return `step_${index}`;
}

/** 단계 한 줄. 무엇을 부르는지가 먼저이고, 제어 조건은 그 아래 줄에 붙인다. */
function stepLabel(step: SystemWorkflowStep, index: number): string {
  const control = [
    step.condition ? runtimeText("조건 충족 시에만", "Only when the condition holds") : null,
    step.forEach ? runtimeText("반복", "Repeats") : null,
    step.expect ? runtimeText("사후검증", "Post-check") : null,
  ].filter(Boolean).join(" · ");
  const head = `${index + 1}. ${step.operation}`;
  return control ? `${head}\n${step.id}\n${control}` : `${head}\n${step.id}`;
}

function inputLabel(contract: SystemWorkflowContract, inputs: string[]): string {
  const named = inputs.map((name) => contract.inputSchema[name]?.label?.trim() || name);
  // 입력이 많으면 상자가 화면을 넘어간다. 앞의 셋만 적고 나머지는 수로 알린다.
  const shown = named.slice(0, 3).join(", ");
  return named.length > 3
    ? runtimeText(`입력 ${shown} 외 ${named.length - 3}개`, `Inputs ${shown} and ${named.length - 3} more`)
    : runtimeText(`입력 ${shown}`, `Inputs ${shown}`);
}

/** 이 단계의 인자·조건·사후검증이 읽는 앞 단계 id. `$step` 토큰만 그렇게 읽을 수 있다. */
function referencedSteps(step: SystemWorkflowStep): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const source = record.$step;
    if (typeof source === "string") found.add(source);
    for (const item of Object.values(record)) walk(item);
  };
  walk(step.arguments);
  walk(step.condition);
  walk(step.expect);
  // 리터럴 목록을 도는 forEach는 앞 단계를 가리키지 않는다.
  if (step.forEach?.step) found.add(step.forEach.step);
  return [...found];
}

/**
 * 라벨에 들어갈 문자열을 mermaid 문법에서 안전하게 만든다.
 *
 * 엔진은 `htmlLabels: false`·`securityLevel: strict`로 돌아 라벨의 HTML은 이미 걸러진다.
 * 여기서 막는 것은 그 앞 단계 — **문법이 깨져 그림이 통째로 안 그려지는 것**이다. 계약의
 * 표시 이름·단계 id·스킬 이름은 사람이나 에이전트가 쓴 문자열이라 따옴표나 대괄호가 들어올
 * 수 있고, 하나만 들어와도 도식 전체가 사라진다.
 */
function escapeLabel(value: string): string {
  return value
    .replace(/[<>]/g, "")
    .replace(/"/g, "#quot;")
    .replace(/[[\]{}()]/g, (bracket) => `#${bracket.charCodeAt(0)};`)
    .replace(/\n/g, "<br/>");
}
