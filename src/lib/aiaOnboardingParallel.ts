/**
 * 병렬 회차로 도는 카드에 앱이 덧붙이는 것 — 병렬 실행 입력 묶음(W6-8)과, 지시문 앞에
 * 서는 레인 서문.
 *
 * 이 묶음은 팩이 아니라 앱이 정한다. 그래서 새 팩을 얻는 것이 새 레인 절차를 얻는 일이
 * 되지 않고, 절차를 고치는 일도 팩 수만큼이 아니라 한 자리로 끝난다.
 *
 * 조립 모듈(`aiaOnboarding.ts`)에 함께 있었는데, 둘은 자라는 축이 다르다 — 레인 절차가
 * 바뀔 때마다 칸과 서문이 손보이는 동안 계약의 뼈대는 그대로였고, 반대로 계약 한 줄을
 * 고치려 해도 칸 여섯 개의 문구 표를 지나쳐 읽어야 했다.
 */
import type {
  AiaOnboardingCard,
  AiaOnboardingField,
  AiaOnboardingOption,
  AiaOnboardingWorkflowTemplate,
} from "../types";
import type { OnboardingValues } from "./aiaOnboardingValues.ts";
import { skillPointer, textValue } from "./aiaOnboardingValues.ts";

/**
 * 병렬 실행 입력의 예약 키(W6-8). 팩이 아니라 앱이 이 묶음을 붙이므로 키를 여기 한
 * 곳에서만 정한다 — 팩마다 제 이름으로 적게 두면 서문을 조립할 때 어느 키를 봐야 할지가
 * 팩마다 달라진다.
 */
export const PARALLEL_FIELD_KEYS = {
  enabled: "parallelEnabled",
  runs: "parallelRuns",
  pool: "lanePool",
  devLine: "laneDevLine",
  landing: "laneLanding",
  split: "laneSplit",
} as const;

/** 병렬 회차가 따르는 레인 절차 스킬의 키. 백엔드 `LANE_SKILL_KEY`와 같아야 한다. */
export const LANE_SKILL_KEY = "parallel-round-lanes";

/**
 * 병렬 실행 입력의 기본값(W6-8). 칸 표가 사용자에게 보여 주는 값과, 서문이 빈 칸을
 * 만났을 때 대신 적는 값이 같은 자리에서 나온다.
 *
 * 두 값이 따로 적혀 있었다 — `parallelFields`의 `defaultValue`와 `lanePreamble`의
 * 대체값이고, 대체값 쪽은 `?? "..."`와 `|| "..."`로 한 칸마다 두 번씩 더 적혀 있어 같은
 * 문자열이 셋씩 있었다. 레인 풀 이름이나 작업브랜치를 바꾸려면 여섯 자리를 함께 고쳐야 했고,
 * 서문 쪽을 빠뜨리면 칸을 비운 채 등록한 회차만 옛 기본값으로 도는 쪽으로 갈린다 — 둘 다
 * 문자열이라 형식 오류가 나지 않고, 칸을 채워 등록한 회차에서는 드러나지도 않는다.
 */
const PARALLEL_DEFAULTS = {
  runs: "3",
  pool: ".rounds",
  devLine: "origin/main",
} as const;

/**
 * 고르는 칸 하나의 갈래. 드롭다운에 서는 문구와 서문이 이 갈래를 적을 때 쓰는 문구가
 * 한 줄에서 나온다.
 *
 * 두 문구가 따로 적혀 있었다 — 옵션 표의 `label.ko`와 `lanePreamble`의 삼항 문자열이고,
 * 갈래마다 기본값까지 `PARALLEL_DEFAULTS`에 한 번 더 적혀 세 자리가 같은 갈래를 나눠
 * 알고 있었다. 실제로 이미 갈려 있다 — 반영 방식 `local`을 화면은 "레인 브랜치에 커밋만"
 * 으로, 서문은 "로컬 커밋만"으로 적는다. 갈래를 더하거나 값을 바꿀 때 서문 쪽을 빠뜨리면
 * 화면에서 고른 것과 지시문에 실리는 것이 조용히 달라지고, 둘 다 문자열이라 형식 오류가
 * 나지 않는다. 갈래가 자기 세 가지를 한 줄로 갖게 둔다(문구는 지금 값 그대로다).
 */
interface ParallelChoice {
  value: string;
  label: { ko: string; en: string };
  /** 서문이 이 갈래를 적을 때 쓰는 문구. */
  preamble: string;
}

/** 첫 줄이 곧 기본값이자 알 수 없는 값이 들어왔을 때의 대체다. */
const SPLIT_CHOICES: readonly ParallelChoice[] = [
  { value: "item", label: { ko: "항목 점유", en: "Claim an item" }, preamble: "항목 점유" },
  { value: "path", label: { ko: "경로 소유", en: "Own paths" }, preamble: "경로 소유" },
];

const LANDING_CHOICES: readonly ParallelChoice[] = [
  {
    value: "push",
    label: { ko: "푸시 락으로 작업브랜치에 반영", en: "Push to the work branch behind a lock" },
    preamble: "푸시 락으로 작업브랜치에 반영",
  },
  {
    value: "local",
    label: { ko: "레인 브랜치에 커밋만", en: "Commit to the lane branch only" },
    preamble: "로컬 커밋만",
  },
];

/** 저장된 값이 가리키는 갈래. 비었거나 모르는 값이면 첫 줄로 떨어진다. */
function chosen(choices: readonly ParallelChoice[], value: string | undefined): ParallelChoice {
  return choices.find((choice) => choice.value === value) ?? choices[0];
}

function choiceOptions(choices: readonly ParallelChoice[]): AiaOnboardingOption[] {
  return choices.map((choice) => ({ value: choice.value, label: { ...choice.label } }));
}

/**
 * 칸 하나의 뼈대. 병렬 묶음의 여섯 칸이 이름·종류와 몇 항목만 다르고 나머지 아홉 항목은
 * 같아, 칸마다 그 아홉 줄을 다시 적지 않도록 기본 모양을 여기 둔다.
 */
function field(
  key: string,
  ko: string,
  en: string,
  kind: AiaOnboardingField["kind"],
  extra: Partial<AiaOnboardingField> = {},
): AiaOnboardingField {
  return {
    key,
    label: { ko, en },
    kind,
    required: false,
    wide: false,
    placeholder: null,
    help: null,
    defaultValue: null,
    options: [],
    min: null,
    max: null,
    visibleWhen: null,
    allowOther: false,
    ...extra,
  };
}

/**
 * 카드에 붙는 병렬 실행 입력 묶음. 병렬을 선언한 워크플로 산출물이 있는 카드의 마지막
 * 단계에 앱이 덧붙인다. 기본은 **꺼짐**이다 — 레인 풀·디스크·작업브랜치 푸시가 프로젝트마다
 * 성립하는지 다르므로, 사용자가 켤 때만 병렬로 돈다.
 */
export function parallelFields(projectPathField: string): AiaOnboardingField[] {
  const onlyWhenOn = { visibleWhen: { field: PARALLEL_FIELD_KEYS.enabled, equals: "true" } };

  return [
    field(PARALLEL_FIELD_KEYS.enabled, "병렬 실행", "Run in parallel", "toggle", {
      defaultValue: "false",
      wide: true,
      help: {
        ko: "여러 회차가 같은 저장소에서 동시에 돕니다. 레인 전용 워크트리에서 일하고 반영은 락 하나로 직렬화합니다.",
        en: "Several rounds run on the same repository at once, each in its own lane worktree, landing serialized by one lock.",
      },
    }),
    // 상한을 두지 않는다. 실제 동시 건수는 사용량 예산의 계정 여력과 가드 창이 자르므로
    // (페이싱 회차 편집기도 하한만 둔다) 화면에서 한 번 더 막을 근거가 없다.
    field(PARALLEL_FIELD_KEYS.runs, "동시 실행 건수", "Concurrent runs", "number", {
      defaultValue: PARALLEL_DEFAULTS.runs,
      min: 2,
      ...onlyWhenOn,
    }),
    field(PARALLEL_FIELD_KEYS.split, "분할 방식", "Split model", "select", {
      defaultValue: SPLIT_CHOICES[0].value,
      options: choiceOptions(SPLIT_CHOICES),
      ...onlyWhenOn,
    }),
    field(PARALLEL_FIELD_KEYS.pool, "레인 풀", "Lane pool", "text", {
      defaultValue: PARALLEL_DEFAULTS.pool,
      help: {
        ko: `${projectPathField} 아래의 상대 경로. 저장소에 커밋되지 않게 .git/info/exclude에 더해집니다.`,
        en: "Relative to the project. Added to .git/info/exclude so it is never committed.",
      },
      ...onlyWhenOn,
    }),
    field(PARALLEL_FIELD_KEYS.devLine, "레인 작업브랜치", "Lane branch", "text", {
      defaultValue: PARALLEL_DEFAULTS.devLine,
      help: {
        ko: "레인이 이 지점에서 갈라지고 반영도 여기로 합니다. <리모트>/<가지> 형식으로 적습니다 — 리모트가 없으면 반영하지 않고 레인 브랜치에 커밋만 남깁니다.",
        en: "Lanes branch from here and land back onto it. Write it as <remote>/<branch>; without a remote the round only commits to its lane branch.",
      },
      ...onlyWhenOn,
    }),
    field(PARALLEL_FIELD_KEYS.landing, "반영 방식", "Landing", "select", {
      defaultValue: LANDING_CHOICES[0].value,
      options: choiceOptions(LANDING_CHOICES),
      wide: true,
      ...onlyWhenOn,
    }),
  ];
}

/** 이 카드가 병렬로 돌 수 있는지. 등록할 워크플로가 선언한다. */
export function supportsParallel(card: AiaOnboardingCard): boolean {
  return card.actions.some((action) => action.kind === "registerWorkflow" && action.workflow.parallel);
}

/** 사용자가 병렬을 켰는지. 꺼져 있으면 서문도 레인 스킬도 붙지 않는다. */
export function parallelEnabled(values: OnboardingValues): boolean {
  return values[PARALLEL_FIELD_KEYS.enabled] === "true";
}

/**
 * 한 회차에 동시에 띄울 건수. 병렬이 꺼져 있으면 1이다. 상한은 두지 않는다 — 실제
 * 동시 건수는 계정 여력과 가드 창이 자른다. 켠 채로 1을 적는 것은 병렬이 아니므로
 * 하한 2로 올린다.
 */
export function parallelRuns(values: OnboardingValues): number {
  if (!parallelEnabled(values)) return 1;
  const runs = Math.round(Number(values[PARALLEL_FIELD_KEYS.runs]));
  return Number.isFinite(runs) ? Math.max(2, runs) : 2;
}

/**
 * 지시문 앞에 붙는 레인 서문. 절차 자체는 `parallel-round-lanes` 스킬에 있고 여기에는
 * 그 절차가 읽을 값만 적는다 — 서문에 절차를 베껴 두면 스킬을 고쳐도 이미 등록된
 * 워크플로는 옛 절차를 들고 돈다.
 */
export function lanePreamble(
  template: AiaOnboardingWorkflowTemplate,
  values: OnboardingValues,
  skillsRoot = "",
): string {
  const projectPath = textValue(values, template.projectPathField);
  const pool = textValue(values, PARALLEL_FIELD_KEYS.pool, PARALLEL_DEFAULTS.pool);
  const devLine = textValue(values, PARALLEL_FIELD_KEYS.devLine, PARALLEL_DEFAULTS.devLine);
  const split = chosen(SPLIT_CHOICES, values[PARALLEL_FIELD_KEYS.split]).preamble;
  const landing = chosen(LANDING_CHOICES, values[PARALLEL_FIELD_KEYS.landing]).preamble;

  return [
    "## 병렬 실행",
    "",
    `이 회차는 최대 ${parallelRuns(values)}건이 동시에 돈다. **레인 절차는 ${skillPointer(LANE_SKILL_KEY, skillsRoot)}를 따른다** — 레인을 점유하고, 레인 전용 워크트리에서만 일하고, 반영을 락으로 직렬화한다.`,
    "",
    `- 병렬 수: ${parallelRuns(values)}`,
    `- 저장소: ${projectPath}`,
    `- 레인 풀: ${projectPath}/${pool}`,
    `- 레인 작업브랜치: ${devLine}`,
    `- 반영 방식: ${landing}`,
    `- 분할: ${split}`,
    "",
    "주 워크트리에서 파일을 고치거나 커밋하지 않는다. 레인이나 워크트리를 얻지 못하면 아무것도 하지 않고 그 사실만 보고하고 끝낸다. 마일스톤·티켓처럼 저장소 밖의 상태는 반영이 성공한 뒤에만 완료로 바꾼다.",
    "",
    "---",
    "",
  ].join("\n");
}
