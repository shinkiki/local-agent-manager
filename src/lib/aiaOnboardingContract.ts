/**
 * 온보딩 카드가 모은 값으로 **회차 계약 한 벌**을 조립하는 자리(W6-2).
 *
 * 팩은 워크플로의 이름·설명·지시문만 주고, `start_chat` 한 단계짜리 계약의 뼈대와 그
 * 계약이 갖는 권한은 앱이 붙인다. 그래서 새 팩을 얻는 것이 새 권한을 얻는 일이 되지
 * 않는다.
 *
 * `aiaOnboarding.ts`에서 떼어낸 것은 자라는 축이 다르기 때문이다 — 저쪽은 "만들기 전에
 * 무엇을 막는가"(사전검사)와 "무엇을 함께 만드는가"(절차 스킬·회차)가 늘어나는 자리고,
 * 여기는 계약의 뼈대와 권한 한 벌이 바뀌는 자리다. 한 파일에 있는 동안은 사전검사 한 줄을
 * 고치려 해도 수동 실행 요청 열네 줄을 지나쳐 읽어야 했다. 호출부가 보는 자리는 그대로다 —
 * `aiaOnboarding.ts`가 이름을 다시 내보낸다.
 */
import type {
  AiaOnboardingWorkflowTemplate,
  SystemWorkflowContract,
  WorkflowChatRuntime,
  WorkflowInputField,
} from "../types";
import type { OnboardingValues } from "./aiaOnboardingValues.ts";
import { fillTemplate, skillPointer, textValue } from "./aiaOnboardingValues.ts";
import { collapseWhitespace } from "./boundedText.ts";
import { LANE_SKILL_KEY, lanePreamble, parallelEnabled } from "./aiaOnboardingParallel.ts";

/**
 * 워크플로 id로 쓸 수 있게 다듬는다. 사용자가 그 칸에 무엇을 치든 등록이 거절되지
 * 않도록 소문자·숫자·하이픈만 남긴다.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
}

/**
 * 이 템플릿이 지금 값으로 가질 워크플로 id. 같은 값이 계약의 id이자 전용 절차 스킬의
 * 키이고, 등록 전 검사가 "받아 줄 이름인가"를 보는 값이기도 하다.
 *
 * 세 자리가 각자 `slugify(fillTemplate(...))`을 적고 있었다. 다듬는 규칙을 바꾸면서 한
 * 자리를 놓쳐도 형식 오류가 나지 않는다 — 계약은 한 이름으로 등록되는데 절차 스킬은 다른
 * 이름으로 만들어져, 그 회차는 계약이 건 의존을 영영 채우지 못한 채 미설치 경고를 달고
 * 돈다. 짓는 자리를 한 줄로 둔다.
 */
export function workflowContractId(
  template: Pick<AiaOnboardingWorkflowTemplate, "id">,
  values: OnboardingValues,
): string {
  return slugify(fillTemplate(template.id, values));
}

/** User-named procedure skills are workflow dependencies, not prompt prose. */
export function selectedProcedureSkillKeys(values: OnboardingValues): string[] {
  return ["roundSkill", "qaSkill"]
    .map((key) => textValue(values, key))
    .filter((key, index, keys) => key.length > 0 && keys.indexOf(key) === index);
}

function stringInput(label: string, defaultValue: string, required: boolean): WorkflowInputField {
  return { type: "string", values: null, required, description: null, label, defaultValue };
}

/**
 * 이 계약이 대화를 띄울 권한 한 벌.
 *
 * 같은 세 값이 두 자리에 나뉘어 적혀 있었다 — 계약의 `chatRuntime`(등록 화면이 읽어
 * 승인 요약에 적는 자리)과 수동 실행 대화 요청. 한쪽만 고치면 화면이 알려 주는 권한과
 * 실제로 시작되는 권한이 갈리는데, 셋 다 문자열이라 형식 오류가 나지 않는다. 한 벌만
 * 두고 두 자리가 이 값을 본다.
 *
 * 페이싱 회차 요청에는 이 세 칸이 아예 없다 — 봉투가 정한 실행설정으로 뜨므로 계약이
 * 다시 적지 않는다. `chatRuntime`은 계약 단위 선언이라 두 갈래 모두에 그대로 선다.
 */
const CONTRACT_CHAT_RUNTIME: WorkflowChatRuntime = {
  mode: "fullAccess",
  approvalMode: "never",
  decisionPolicy: "recommended",
};

/**
 * 계약이 받는 입력 칸. 페이싱 회차는 봉투가 레인마다 다른 모델을 고를 수 있게 공급자별
 * 모델 칸을 두고, 봉투가 없는 수동 실행은 공급자를 골라 받는다.
 */
function contractInputSchema(
  projectPath: string,
  message: string,
  paced: boolean,
): Record<string, WorkflowInputField> {
  const inputSchema: Record<string, WorkflowInputField> = {
    projectPath: stringInput("작업 경로", projectPath, true),
    message: stringInput("지시문", message, true),
  };
  if (paced) {
    inputSchema.claudeModel = stringInput("Claude 모델", "", false);
    inputSchema.codexModel = stringInput("Codex 모델", "", false);
    inputSchema.antigravityModel = stringInput("Antigravity 모델", "", false);
    // 로컬은 사용량 한도가 없어 계정 여력으로 건수를 정할 수 없다. 참여할 모델을 직접
    // 고르고, 고른 모델마다 한 건씩 상한 밖에서 선다. 값은 쉼표로 이어 붙인다.
    inputSchema.localModels = stringInput("로컬 모델(여럿)", "", false);
  } else {
    inputSchema.source = {
      type: "enum",
      // 페이싱 쪽 모델 입력과 달리 여기엔 로컬도 넣는다 — 일반 채팅은 사용량 창이
      // 없어도 돌고, 빠뜨리면 카드에서 고를 수 없는 공급자가 된다.
      values: ["claude", "codex", "antigravity", "local"],
      required: true,
      description: null,
      label: "실행 공급자",
      defaultValue: "claude",
    };
  }
  return inputSchema;
}

/**
 * 페이싱 회차의 대화 요청. 봉투가 정한 계정·모델·경로·실행설정을 `$run` 토큰으로 받는다 —
 * 이미 도는 회차 계약과 같은 모양이다.
 */
function pacedChatRequest(): Record<string, unknown> {
  return {
    accountId: { $run: "accountId" },
    cwd: { $run: "cwd" },
    model: { $run: "model" },
    pinAccount: true,
    profile: "standard",
    reasoningEffort: { $run: "reasoningEffort" },
    settings: {},
    source: { $run: "source" },
    unattended: true,
  };
}

/**
 * 수동 실행의 대화 요청. 봉투가 없으므로 공급자를 입력으로 받아 활성 계정으로 띄우고,
 * 사용자가 화면에서 직접 돌리는 것이라 무인(unattended)으로 숨기지 않는다.
 */
function manualChatRequest(): Record<string, unknown> {
  return {
    accountId: null,
    approvalMode: CONTRACT_CHAT_RUNTIME.approvalMode,
    cwd: { $input: "projectPath" },
    decisionPolicy: CONTRACT_CHAT_RUNTIME.decisionPolicy,
    handoffOrigin: null,
    mode: CONTRACT_CHAT_RUNTIME.mode,
    model: null,
    pinAccount: false,
    profile: "standard",
    reasoningEffort: null,
    resumeSessionId: null,
    settings: {},
    source: { $input: "source" },
    unattended: false,
  };
}

/**
 * 회차 계약의 뼈대. 입력 칸과 대화 요청은 페이싱 여부로 통째로 갈리고, 나머지(식별자·
 * 문구·단계 하나·위험도·의존 스킬)는 두 갈래가 함께 쓴다. 갈리는 쪽을 갈래별 함수로
 * 가르고 여기에는 함께 쓰는 뼈대만 남긴다 — 페이싱 쪽 칸 하나를 고치려고 수동 실행
 * 요청 열네 줄을 지나쳐 읽을 일이 없게 한다.
 */
export function buildWorkflowContract(
  template: AiaOnboardingWorkflowTemplate,
  values: OnboardingValues,
  { paced, skillsRoot = "" }: { paced: boolean; skillsRoot?: string },
): SystemWorkflowContract {
  const projectPath = textValue(values, template.projectPathField);
  // 병렬을 켰으면 레인 서문이 지시문 앞에 선다. 절차는 스킬이 들고 있고 서문은 값만
  // 전하므로, 스킬을 고치면 이미 등록된 회차도 다음 실행부터 새 절차를 따른다.
  // 레인 절차는 실제로 페이싱 회차를 여러 개 만들 때만 필요하다. 수동 실행은 한 채팅만
  // 시작하므로, 로컬 LLM처럼 수동 실행만 가능한 공급자에 병렬 지시를 붙이지 않는다.
  const parallel = paced && template.parallel && parallelEnabled(values);
  const selectedSkills = selectedProcedureSkillKeys(values);
  const filled = fillTemplate(template.message, values);
  const message = parallel ? `${lanePreamble(template, values, skillsRoot)}${filled}` : filled;
  const chat = paced ? pacedChatRequest() : manualChatRequest();
  // 절차 스킬은 이 워크플로와 같은 이름을 쓴다. 한 자리에서 계산해 계약 id와 의존이
  // 어긋나지 않게 한다.
  const id = workflowContractId(template, values);
  // 절차 스킬은 방금 만들어진 공통 원본이라 아직 어느 공급자에도 배포돼 있지 않다.
  // 지시문이 절대 경로를 함께 실어야 공급자를 가리지 않고 그 파일을 읽을 수 있다.
  // 절차 문장은 지시문 **앞**에 선다. 뒤에 붙이면 팩이 마지막 줄에 둔 "사용자가 지정한
  // 스킬을 우선한다"를 덮어, 사용자가 적은 스킬 지정이 무력해진다.
  const withProcedure = template.procedure
    ? `**절차는 ${skillPointer(id, skillsRoot)}를 따른다.**\n\n${message}`
    : message;

  return {
    id,
    // 등록은 이름·설명에 제어문자를 받지 않는다. 여러 줄 textarea 값이 치환돼 들어오면
    // 그대로는 거절되므로 한 줄로 만든다(지시문은 여러 줄 그대로 간다).
    displayName: collapseWhitespace(fillTemplate(template.displayName, values)),
    description: collapseWhitespace(fillTemplate(template.description, values)),
    inputSchema: contractInputSchema(projectPath, withProcedure, paced),
    steps: [
      {
        id: "run",
        operation: "start_chat",
        arguments: { request: { chat, idempotencyKey: { $idempotencyKey: true }, message: { $input: "message" } } },
        forEach: null,
        condition: null,
        expect: null,
      },
    ],
    risk: "mutating",
    version: null,
    paced,
    chatRuntime: { ...CONTRACT_CHAT_RUNTIME },
    requiredSkills: [
      ...template.requiredSkills.filter((key) => key.trim().length > 0),
      ...selectedSkills,
      // 이 워크플로 전용 절차 스킬. 만들기가 같은 이름으로 만든다.
      ...(template.procedure ? [id] : []),
      // 레인 절차를 따르게 하는 의존이다. 화면이 미설치를 경고할 수 있도록 계약에 남긴다.
      ...(parallel ? [LANE_SKILL_KEY] : []),
    ],
  };
}
