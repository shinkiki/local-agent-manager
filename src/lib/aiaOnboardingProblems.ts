/**
 * 온보딩 카드가 모은 값으로 **무엇을 막는가**만 아는 자리.
 *
 * 이 사전검사는 조립·설치와 함께 `aiaOnboarding.ts`에 있었다. 그 파일의 머리글이 이미
 * "여기 남은 것은 두 가지"라고 적어 둘 만큼 두 결이 갈려 있었고, 자라는 축도 다르다 —
 * 등록이 거절하는 조건은 백엔드 한도가 바뀔 때마다 늘지만, 절차 스킬과 회차를 어떻게
 * 만드는지는 거의 그대로였다. 한 파일에 있는 동안은 한도 한 줄을 고치려 해도 스킬 설치
 * 계획과 회차 입력 뼈대를 지나쳐 읽어야 했다.
 *
 * 검사는 셋이고 보는 것이 서로 다르다 — 하나는 값만(`workflowIdProblems`), 하나는 카드의
 * 칸을(`recordTargetProblems`), 하나는 조립을 마친 계약을(`contractProblems`) 본다.
 * `creationProblems`에는 "무엇을 어떤 순서로 보는가"만 남는다.
 *
 * 기존 호출부가 경로를 바꾸지 않도록 이 모듈의 이름은 `aiaOnboarding.ts`가 그대로 다시
 * 내보낸다.
 */
import type { AiaOnboardingCard, SystemWorkflowContract } from "../types";
import type { OnboardingValues } from "./aiaOnboardingValues.ts";
import { fillTemplate } from "./aiaOnboardingValues.ts";
import { activeWorkflows, cardSteps, visibleFields } from "./aiaOnboardingCard.ts";
import { buildWorkflowContract, workflowContractId } from "./aiaOnboardingContract.ts";
import { runtimeText } from "./i18nRuntime.ts";

/**
 * 기록·마일스톤을 남길 수 있는 곳. 마크다운은 앱이 스스로 쓰므로 **플러그인 없이도**
 * 언제나 선택지이고, 노션·지라는 그 플러그인이 붙어 있을 때만 는다. 화면이 그리는 목록과
 * 사전검사가 보는 목록이 같은 표에서 나와야, 플러그인 조회가 실패했을 때 무엇을 막고
 * 무엇을 통과시킬지가 두 자리에서 갈리지 않는다.
 */
export const RECORD_TARGETS = [
  { id: "markdown", ko: "마크다운 문서(.md)", en: "Markdown documents (.md)", needles: [] },
  { id: "notion", ko: "노션", en: "Notion", needles: ["notion"] },
  { id: "jira", ko: "지라", en: "Jira", needles: ["jira", "atlassian"] },
] as const;

/** 붙어 있는 플러그인과 무관하게 고를 수 있는 기록 대상. */
const PLUGIN_FREE_RECORD_TARGETS = RECORD_TARGETS.filter((target) => target.needles.length === 0)
  .map((target) => target.id) as readonly string[];

/**
 * 지금 값으로는 만들 수 없는 워크플로와 그 이유.
 *
 * 워크플로 id와 절차 스킬 키는 `slugify`를 거치므로 한글·기호만 적은 값은 통째로
 * 걸러진다. 그러면 프로젝트가 달라도 같은 키가 나와 **다른 프로젝트의 워크플로에 새
 * 버전으로 덮어쓰고 절차 스킬도 한 벌을 나눠 쓰게 된다.** 등록 전에 막는다.
 */
export function workflowIdProblems(card: AiaOnboardingCard, values: OnboardingValues): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const workflow of activeWorkflows(card, values)) {
    const filled = fillTemplate(workflow.id, values);
    const id = workflowContractId(workflow, values);
    // 치환 자리가 있는데 치환 뒤에도 빈 자리일 때와 값이 통째로 걸러졌을 때만 막는다.
    // 자리가 없는 고정 id는 사용자가 적는 값이 아니므로 이 검사의 대상이 아니다.
    const templated = /\{\{/.test(workflow.id);
    const carriesValue = !templated || id !== workflowContractId(workflow, {});
    // 등록은 "영소문자로 시작하는 2~64자"만 받는다. 여기서 같은 기준으로 보지 않으면
    // 절차 스킬을 먼저 만든 뒤 등록에서 거절돼 쓰지 않는 스킬만 남는다.
    const registrable = id.length >= 2 && id.length <= 64 && /^[a-z]/.test(id);
    if (!registrable || !carriesValue) {
      problems.push(`${filled || workflow.id}: ${runtimeText(
        "워크플로 id는 영소문자로 시작하는 2~64자여야 합니다. 영소문자·숫자·하이픈으로 적어 주세요.",
        "A workflow id must be 2-64 characters starting with a lowercase letter. Use lowercase letters, digits, and hyphens.",
      )}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${id}: ${runtimeText(
        "같은 워크플로 이름이 두 번 만들어집니다.",
        "The same workflow name would be created twice.",
      )}`);
    }
    seen.add(id);
  }
  return problems;
}

/** 계약 입력 한 칸에 담을 수 있는 글자 수. 백엔드 `MAX_INPUT_STRING_LEN`과 같아야 한다. */
export const MAX_CONTRACT_INPUT_CHARS = 4096;
/** 계약의 이름·설명 한도. 백엔드 `MAX_NAME_LEN`·`MAX_DESCRIPTION_LEN`과 같아야 한다. */
export const MAX_CONTRACT_NAME_CHARS = 120;
export const MAX_CONTRACT_DESCRIPTION_CHARS = 2000;
/** 계약이 걸 수 있는 스킬 수. 백엔드 `MAX_REQUIRED_SKILLS`와 같아야 한다. */
export const MAX_CONTRACT_REQUIRED_SKILLS = 8;

/**
 * 지금 붙어 있는 플러그인으로는 고를 수 없는 기록 대상.
 *
 * `recordTargets`가 **null이면 목록을 읽지 못한 것**이라 그 대상에 플러그인이 필요한지
 * 확인할 길이 없다. 화면의 드롭다운은 비어 보이는데 값은 남아 있으므로, 사용자가 고르지
 * 않은 대상으로 회차가 등록되는 쪽이 아니라 멈추는 쪽을 고른다. 다만 플러그인 없이도
 * 되는 대상까지 막으면 그 조회가 계속 실패하는 장치에서는 영영 만들 수 없다.
 */
function recordTargetProblems(
  card: AiaOnboardingCard,
  values: OnboardingValues,
  recordTargets: readonly string[] | null,
): string[] {
  const problems: string[] = [];
  for (const step of cardSteps(card)) {
    for (const field of visibleFields(step, values)) {
      const value = (values[field.key] ?? "").trim();
      if (field.kind !== "recordTargetPicker" || value.length === 0) continue;
      if (recordTargets === null) {
        if (!PLUGIN_FREE_RECORD_TARGETS.includes(value)) {
          problems.push(`${value}: ${runtimeText(
            "붙어 있는 플러그인을 읽지 못해 기록 대상을 확인할 수 없습니다. 다시 열어 주세요.",
            "The connected plugins could not be read, so this record target cannot be verified. Please reopen.",
          )}`);
        }
      } else if (!recordTargets.includes(value)) {
        problems.push(`${value}: ${runtimeText(
          "지금 붙어 있는 플러그인으로는 고를 수 없는 기록 대상입니다.",
          "This record target is not available with the currently connected plugins.",
        )}`);
      }
    }
  }
  return problems;
}

/**
 * 조립을 마친 계약 하나를 등록 한도로 본다. 팩 한도(지시문 4,000·이름 200·설명 600자)는
 * 계약 한도와 달라, 값 치환과 앱이 붙이는 줄이 더해지면 등록이 거절한다.
 */
function contractProblems(contract: SystemWorkflowContract, paced: boolean): string[] {
  const problems: string[] = [];
  const message = contract.inputSchema.message.defaultValue;
  // 지시문·이름·설명 세 자리를 같은 기준으로 본다.
  const limits: [string, string, number][] = [
    [runtimeText("지시문", "instructions"), typeof message === "string" ? message : "", MAX_CONTRACT_INPUT_CHARS],
    [runtimeText("이름", "name"), contract.displayName, MAX_CONTRACT_NAME_CHARS],
    [runtimeText("설명", "description"), contract.description, MAX_CONTRACT_DESCRIPTION_CHARS],
  ];
  for (const [label, value, limit] of limits) {
    if (value.length > limit) {
      problems.push(`${contract.id}: ${runtimeText(
        `${label}이(가) ${value.length}자로 한도(${limit}자)를 넘습니다. 적은 값을 줄이세요.`,
        `The ${label} is ${value.length} characters, over the ${limit}-character limit. Shorten what you entered.`,
      )}`);
    }
  }
  // 팩이 적은 의존에 절차 키와 레인 키가 더해져 한도를 넘거나 겹칠 수 있다.
  const skills = contract.requiredSkills ?? [];
  if (skills.length > MAX_CONTRACT_REQUIRED_SKILLS) {
    problems.push(`${contract.id}: ${runtimeText(
      `따를 스킬이 ${skills.length}개로 한도(${MAX_CONTRACT_REQUIRED_SKILLS}개)를 넘습니다.`,
      `${skills.length} skills are attached, over the limit of ${MAX_CONTRACT_REQUIRED_SKILLS}.`,
    )}`);
  }
  if (new Set(skills).size !== skills.length) {
    problems.push(`${contract.id}: ${runtimeText(
      "따를 스킬이 겹칩니다.",
      "The attached skills contain duplicates.",
    )}`);
  }
  // 페이싱 계약은 봉투가 이 경로로 런타임을 띄우므로 비어 있으면 회차마다 실패한다.
  if (paced && String(contract.inputSchema.projectPath?.defaultValue ?? "").trim().length === 0) {
    problems.push(`${contract.id}: ${runtimeText(
      "작업 경로가 비어 있습니다. 프로젝트를 고르세요.",
      "The work path is empty. Choose a project.",
    )}`);
  }
  return problems;
}

/**
 * 만들기 전에 막아야 하는 것 전부. 절차 스킬을 먼저 만들고 등록에서 죽으면 쓰지 않는
 * 스킬만 남으므로, 등록이 거절할 것을 **아무것도 만들기 전에** 본다.
 *
 * - 걸러지는 워크플로 id: 다른 프로젝트 워크플로를 덮어쓴다(`workflowIdProblems`).
 * - 고를 수 없는 기록 대상: 그 플러그인이 없는데 그 대상으로 회차가 등록된다
 *   (`recordTargetProblems`).
 * - 등록 한도를 넘는 지시문·이름·설명·스킬 의존과 빈 작업 경로(`contractProblems`).
 *
 * 세 검사는 보는 것이 다르다 — 하나는 값만, 하나는 카드의 칸을, 하나는 조립을 마친
 * 계약을 본다. 검사 하나를 고치려고 나머지 둘을 지나쳐 읽을 일이 없도록 자리를 나누고,
 * 여기에는 "무엇을 어떤 순서로 보는가"만 남긴다.
 */
/**
 * 노션 주소에서 데이터베이스 id(32자리 16진수)를 뽑는다. 주소 형태가 여러 가지라
 * (`notion.so/<작업공간>/<id>?v=…`, `app.notion.com/p/<id>`, 하이픈 섞인 UUID) 눈으로
 * 맞히기 어렵다. 페이지가 수천 개인 작업공간에서는 목록에서 고르는 것보다 붙여넣는 것이
 * 빠르므로, **고르게 하는 대신 붙여넣은 값이 데이터베이스를 가리키는지 여기서 본다.**
 *
 * id는 주소의 **끝**에 붙는다(`…/<제목 슬러그>-<id>`). 하이픈을 떼면 슬러그의 꼬리가 id와
 * 한 덩어리로 이어지므로, 덩어리의 왼쪽부터 32자를 끊으면 한 칸씩 밀린 값이 나온다 —
 * `Bug-Fix-Database-<id>`의 `…Database`에서 `e` 하나가 앞에 붙는 식이다. 밀린 값도 32자
 * 16진수라 모양만으로는 멀쩡해 이 검사를 통과하고, 그 회차가 "데이터베이스를 찾지 못했다"로
 * 끝나서야 드러난다. 그래서 덩어리에서 끊는 자리를 앞이 아니라 **뒤**로 잡는다.
 */
export function notionDatabaseId(value: string): string | null {
  // 뷰 id(`?v=…`)와 블록 조각(`#…`)에 속지 않도록 경로만 본다. 둘 다 32자 16진수라
  // 모양만으로는 데이터베이스 id와 구분되지 않고, 조각은 주소 끝에 붙어 있어 떼지 않으면
  // 마지막 덩어리로 뽑힌다.
  const path = value.trim().split(/[?#]/)[0].replace(/-/g, "");
  const runs = path.match(/[0-9a-fA-F]{32,}/g);
  if (!runs) return null;
  return runs[runs.length - 1].slice(-32).toLowerCase();
}

/** 지라 프로젝트 키. 대문자로 시작하는 대문자·숫자 2~10자다. */
export function isJiraProjectKey(value: string): boolean {
  return /^[A-Z][A-Z0-9]{1,9}$/.test(value.trim());
}

/**
 * 붙여넣은 주소·키가 그 도구의 것인지. 오타는 첫 회차가 "데이터베이스를 찾지 못했다"로
 * 끝나서야 드러나고, 그때는 워크플로가 이미 등록된 뒤다.
 */
const PROJECT_KEY_FIELDS = new Set(["jiraProject", "jiraProjectKey"]);

export function pastedTargetProblems(card: AiaOnboardingCard, values: OnboardingValues): string[] {
  const problems: string[] = [];
  for (const step of cardSteps(card)) {
    for (const field of visibleFields(step, values)) {
      const value = (values[field.key] ?? "").trim();
      if (value.length === 0) continue;
      // 칸 이름도 화면 언어로 부른다 — 문구만 영어인데 앞머리가 한국어면 한 줄이 두 언어로 갈린다.
      const label = runtimeText(field.label.ko, field.label.en ?? field.label.ko);
      if (/notion/i.test(field.key) && notionDatabaseId(value) === null) {
        problems.push(`${label}: ${runtimeText(
          "노션 데이터베이스 주소가 아닙니다. 그 데이터베이스를 열고 주소창의 주소를 그대로 붙여넣으세요.",
          "This is not a Notion database URL. Open that database and paste the URL from the address bar as is.",
        )}`);
      }
      if (PROJECT_KEY_FIELDS.has(field.key) && !isJiraProjectKey(value)) {
        problems.push(`${label}: ${runtimeText(
          "지라 프로젝트 키는 대문자로 시작하는 2~10자입니다(예: QA).",
          "A Jira project key is 2-10 characters starting with an uppercase letter (for example, QA).",
        )}`);
      }
    }
  }
  return problems;
}

export function creationProblems(
  card: AiaOnboardingCard,
  values: OnboardingValues,
  { paced, skillsRoot, recordTargets }: {
    paced: boolean;
    skillsRoot: string;
    /**
     * 지금 고를 수 있는 기록 대상. **읽지 못했으면 null**이고, 그때는 플러그인이 필요한
     * 대상만 막는다(마크다운처럼 앱이 스스로 쓰는 대상은 그대로 통과시킨다).
     */
    recordTargets: readonly string[] | null;
  },
): string[] {
  const problems = [
    ...workflowIdProblems(card, values),
    ...recordTargetProblems(card, values, recordTargets),
    ...pastedTargetProblems(card, values),
  ];
  for (const workflow of activeWorkflows(card, values)) {
    const contract = buildWorkflowContract(workflow, values, { paced, skillsRoot });
    problems.push(...contractProblems(contract, paced));
  }
  return problems;
}
