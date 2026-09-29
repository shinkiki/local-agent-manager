/**
 * 온보딩 카드가 모은 값으로 실제 산출물을 조립하는 자리(W6).
 *
 * 카드 자체는 데이터라 화면이 그리는 것으로 끝나지만, 마지막에 무엇이 만들어지는지는
 * 팩이 아니라 앱이 정한다 — 팩은 워크플로의 이름·설명·지시문만 주고, `start_chat` 한
 * 단계짜리 계약의 뼈대는 앱이 붙인다(W6-2). 그래서 새 팩을 얻는 것이 새 권한을 얻는
 * 일이 되지 않는다.
 *
 * 화면 컴포넌트가 아니라 이 모듈에 두는 이유는 조립 규칙이 렌더링과 무관하게 검증
 * 가능해야 하기 때문이다. 치환·조건·필수값 판정과 계약 조립은 모두 순수 함수다.
 *
 * 모은 값을 읽는 밑돌은 `aiaOnboardingValues.ts`, 카드의 단계·입력 칸을 읽는 자리는
 * `aiaOnboardingCard.ts`, 병렬 실행 입력과 레인 서문은 `aiaOnboardingParallel.ts`,
 * 계약의 뼈대와 권한 한 벌은 `aiaOnboardingContract.ts`가 갖는다. 다섯은 자라는 축이
 * 다르다 — 레인 절차가 바뀔 때마다 칸 여섯 개와 서문이 손보이고 조건부 노출이 바뀔
 * 때마다 칸 읽기가 손보이는 동안 계약의 뼈대는 그대로였고, 값 읽기는 어느 쪽도 모르는
 * 세 줄이다. 한 파일에 있는 동안은 계약 한 줄을 고치려 해도 그 사이를 지나쳐 읽어야
 * 했다. 기존 호출부가 경로를 바꾸지 않도록 다섯 모듈의 이름은 여기서 그대로 다시 내보낸다.
 *
 * 여기 남은 것은 하나다 — **계약과 함께 무엇을 만드는가**(절차 스킬·회차). 만들기 전에
 * 무엇을 막는지는 `aiaOnboardingProblems.ts`가 갖는다. 두 결은 자라는 축이 다르다 —
 * 등록이 거절하는 조건은 백엔드 한도가 바뀔 때마다 늘지만, 절차 스킬과 회차를 어떻게
 * 만드는지는 거의 그대로였다.
 */
import type {
  AiaOnboardingCard,
  LocalizedText,
  ScheduledRequest,
  ScheduledRequestInput,
} from "../types";
import type { OnboardingValues } from "./aiaOnboardingValues.ts";
import { fillTemplate } from "./aiaOnboardingValues.ts";
import { activeWorkflows } from "./aiaOnboardingCard.ts";
import type { ProcedureSkill, ProcedureSkillFile } from "./aiaOnboardingProcedure.ts";
import { procedureSkillFiles } from "./aiaOnboardingProcedure.ts";
import { collapseWhitespace } from "./boundedText.ts";
import { LANE_SKILL_KEY } from "./aiaOnboardingParallel.ts";
import { workflowContractId } from "./aiaOnboardingContract.ts";

/** 절차 스킬 파일 작성도 마찬가지다. 무엇을 만들지는 여기가 정하고, 어떻게 적을지는 저쪽이 안다. */
export type { ProcedureSkill, ProcedureSkillFile } from "./aiaOnboardingProcedure.ts";
export { procedureSkillFiles } from "./aiaOnboardingProcedure.ts";

/** 값 읽기는 밑돌 모듈이 맡는다. 기존 호출부가 그대로 쓰도록 여기서 다시 내보낸다. */
export type { OnboardingValues } from "./aiaOnboardingValues.ts";
export { conditionHolds, fillTemplate } from "./aiaOnboardingValues.ts";

/** 병렬 실행 입력과 레인 서문도 마찬가지다. 호출부가 보는 자리는 그대로다. */
export {
  LANE_SKILL_KEY,
  PARALLEL_FIELD_KEYS,
  lanePreamble,
  parallelEnabled,
  parallelFields,
  parallelRuns,
  supportsParallel,
} from "./aiaOnboardingParallel.ts";

/** 카드의 단계·입력 칸 읽기도 마찬가지다. 화면과 시험이 보는 자리는 그대로다. */
export {
  activeActions,
  activeWorkflows,
  cardFields,
  cardSteps,
  initialValues,
  missingRequired,
  visibleFields,
} from "./aiaOnboardingCard.ts";

/** 계약 조립도 마찬가지다. 이름 짓기(`slugify`)까지 계약 쪽이 갖는다. */
export { buildWorkflowContract, selectedProcedureSkillKeys, slugify, workflowContractId } from "./aiaOnboardingContract.ts";

/** 사전검사도 마찬가지다. 화면과 시험이 부르는 자리는 그대로다. */
export {
  MAX_CONTRACT_DESCRIPTION_CHARS,
  MAX_CONTRACT_INPUT_CHARS,
  MAX_CONTRACT_NAME_CHARS,
  MAX_CONTRACT_REQUIRED_SKILLS,
  RECORD_TARGETS,
  creationProblems,
  isJiraProjectKey,
  notionDatabaseId,
  workflowIdProblems,
} from "./aiaOnboardingProblems.ts";

/**
 * 만들기 전에 설치해야 하는 절차 스킬. 워크플로마다 제 이름의 복사본이 하나씩 붙고,
 * 병렬을 켰으면 프로젝트를 가리지 않는 레인 절차가 더해진다. 이미 있는 키는 사용자가
 * 손봤을 수 있으므로 건드리지 않는다.
 */
export function plannedProcedureSkills(
  card: AiaOnboardingCard,
  values: OnboardingValues,
  bundled: readonly ProcedureSkill[],
  { parallel, installed }: { parallel: boolean; installed: ReadonlySet<string> },
): ProcedureSkill[] {
  const planned: ProcedureSkill[] = [];
  const seen = new Set<string>();
  const add = (key: string, description: string, files: ProcedureSkillFile[]) => {
    if (installed.has(key) || seen.has(key)) return;
    seen.add(key);
    planned.push({ key, description, files });
  };

  for (const workflow of activeWorkflows(card, values)) {
    const source = workflow.procedure
      ? bundled.find((skill) => skill.key === workflow.procedure)
      : undefined;
    if (source) {
      // 계약이 스스로 짓는 id와 같은 자리에서 나와야 계약이 건 의존과 여기서 만드는
      // 스킬의 키가 갈리지 않는다.
      const key = workflowContractId(workflow, values);
      const description = collapseWhitespace(`${fillTemplate(workflow.displayName, values)} 절차`);
      const body = source.files.find((file) => file.path === "SKILL.md")?.content ?? "";
      add(key, description, procedureSkillFiles(body, key, description));
    }
    if (parallel && workflow.parallel) {
      const lane = bundled.find((skill) => skill.key === LANE_SKILL_KEY);
      if (lane) add(lane.key, lane.description, lane.files);
    }
  }
  return planned;
}

/**
 * 등록한 워크플로를 도는 회차 하나. 주기는 자동(사용량 여력이 정함)이고 꺼진 상태로
 * 만들어, 사용자가 페이싱 탭에서 확인하고 켜게 한다.
 */
export function buildScheduleInput(
  name: string,
  workflowId: string,
  version: number,
  { enabled, timezone, maxRuns = 1 }: { enabled: boolean; timezone: string; maxRuns?: number },
): ScheduledRequestInput {
  return {
    name,
    prompt: "",
    source: "claude",
    accountId: "",
    useActiveAccount: false,
    cwd: "",
    model: null,
    reasoningEffort: null,
    mode: "workspace",
    approvalMode: "never",
    recurrence: { frequency: "auto", interval: 1, hour: 9, minute: 0, weekday: 1, cron: null, timezone },
    sessionStrategy: "newChat",
    resumeFailurePolicy: "retryThenNewChat",
    providerSessionId: null,
    enabled,
    sessionReference: null,
    workflow: { workflowId, approvedVersion: version, arguments: {}, pacing: { maxRuns } },
    activeFrom: null,
    activeUntil: null,
  };
}

/**
 * 회차를 새로 만들지, 있던 것을 고칠지 정한다.
 *
 * 만들기를 다시 누르면 워크플로는 새 버전으로 재등록된다. 그때 회차까지 새로 만들면
 * 같은 이름이 하나씩 늘고 **먼저 만든 것들은 옛 버전에 고정된 채 남는다.** 그 상태로
 * 하나를 켜면 방금 화면에서 정한 내용이 아니라 옛 계약으로 돈다.
 *
 * 켜짐 여부만은 있던 값을 지킨다 — 마법사를 다시 훑었다는 이유로 돌고 있던 회차를
 * 멈추거나 꺼 둔 회차를 되살리지 않는다. 그 밖(이름·병렬 수·승인 버전)은 이번 화면이
 * 정한 값으로 덮는다.
 */
export function roundSavePlan(
  schedules: ScheduledRequest[],
  workflowId: string,
  input: ScheduledRequestInput,
): { id: string | null; input: ScheduledRequestInput } {
  const existing = schedules.find((candidate) => candidate.workflow?.workflowId === workflowId);
  if (!existing) return { id: null, input };
  return { id: existing.id, input: { ...input, enabled: existing.enabled } };
}

/** 한 벌의 문구에서 지금 언어에 맞는 쪽을 고른다. 영어가 없으면 한국어 그대로 쓴다. */
export function localized(value: LocalizedText, text: (ko: string, en: string) => string): string {
  return text(value.ko, value.en ?? value.ko);
}
