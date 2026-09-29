type RepositoryTransferKind = "backup" | "restore";

/**
 * 백업·복구가 공유하는 대상 범위와 금지 사항. 갈래마다 되풀이해 적으면 한쪽만 범위를
 * 좁혔을 때 백업에는 담기고 복구에는 돌아오지 않는 파일이 생긴다.
 */
const REPOSITORY_TRANSFER_COMMON = [
  "먼저 get_resource_repository를 호출해 현재 장치의 rootPath와 skillsPath, instructionsPath를 확인하세요. 대상은 그 공통 저장소의 skills·instructions 하위 전체이며, 다른 경로나 예전 ~/.agents/skills를 추측해서 사용하지 마세요.",
  "skills 아래 각 하위 디렉터리가 보관 스킬 하나이며 SKILL.md, .agent-manager OS 메타데이터·변형, scripts, references, assets 등 구성 파일 전체를 보존해야 합니다. instructions 아래 각 하위 디렉터리가 지침 원본 하나이며 공급자별 지침 파일과 연결 문서, .agent-manager 메타를 함께 보존해야 합니다.",
  "에이전트 스킬 루트(~/.claude/skills, ~/.codex/skills, ~/.gemini/config/skills), 예전 ~/.agents/.skill-lock.json, 공급자 캐시·인증·설정·세션, 채팅·계정 데이터는 포함하거나 변경하지 마세요.",
  "비밀값으로 보이는 파일이나 내용은 백업·복구하지 말고 사용자에게 알리되 실제 비밀값은 출력하지 마세요.",
] as const;

/**
 * 갈래마다 다른 것만. 두 갈래의 줄 순서는 같으므로(용건 → 공통 범위 → 손대기 전 확인 →
 * 본작업 → 마무리) 그 순서는 표 밖에 한 번만 적고, 표는 자리마다 들어갈 문장만 가진다.
 */
const REPOSITORY_TRANSFER_PROMPTS: Record<RepositoryTransferKind, {
  heading: string;
  steps: readonly string[];
}> = {
  backup: {
    heading: "스킬·지침 공통 저장소 백업을 도와주세요.",
    steps: [
      "백업 저장 위치를 먼저 사용자에게 확인하세요. 확인 전에는 파일을 생성하거나 변경하지 마세요.",
      "확인 후 이식 가능한 백업(디렉터리 사본 또는 압축)을 만들고, 리소스 키·상대 경로·파일 해시·실행 권한을 담은 비밀값 없는 manifest를 함께 넣으세요.",
      "완료 후 백업 위치, 포함/제외한 스킬·지침 수, 주의사항과 검증 결과를 요약하세요.",
    ],
  },
  restore: {
    heading: "스킬·지침 공통 저장소 복구를 도와주세요.",
    steps: [
      "복구할 백업 위치와 기존 보관 원본과의 충돌 처리 방식을 먼저 사용자에게 확인하세요. 확인 전에는 파일을 생성·덮어쓰기·삭제하지 마세요.",
      "manifest와 파일 해시를 검증한 뒤 get_resource_repository가 반환한 skillsPath·instructionsPath 아래로 복원하세요. 기존 보관 원본은 명시적 승인 없이 덮어쓰지 말고, 백업에 없는 파일을 삭제하지 마세요.",
      "복구 후에는 스킬관리 화면에서 각 에이전트의 사용 여부를, 지침관리 화면에서 게시 위치를 다시 켜야 배포된다는 점을 사용자에게 안내하세요.",
      "완료 후 복원된 스킬·지침 수, 충돌 처리, 검증 결과를 요약하세요.",
    ],
  },
};

/**
 * 장치별로 설정된 공통 리소스 저장소(스킬 원본 + 프로젝트 지침 원본)를 백업·복구하도록
 * AIA에게 요청한다. 경로를 프롬프트에 고정하지 않고 typed 조회 결과를 사용하게 한다.
 */
export function repositoryTransferPrompt(kind: RepositoryTransferKind): string {
  const { heading, steps } = REPOSITORY_TRANSFER_PROMPTS[kind];
  return [heading, ...REPOSITORY_TRANSFER_COMMON, ...steps].join("\n");
}

type BulkMigrationKind = "skill" | "instruction";

/**
 * 일괄 마이그레이션 갈래 하나가 아는 것. 리소스 이름과 typed API 단계만 다르고 줄 순서는
 * 같다 — 용건 → 열거 → 참고 개수 → 항목별 계획 → 저장 → 정적 검토 → 항목별 결과.
 *
 * 그 순서를 갈래마다 적고 있었다. 두 벌이면 한쪽에 단계를 끼워 넣어도 다른 쪽은 그대로라,
 * 같은 성격의 작업인데 AIA가 받는 지시의 얼개가 갈래마다 달라진다.
 */
const BULK_MIGRATION_PROMPTS: Record<BulkMigrationKind, {
  heading: string;
  listStep: string;
  planStep: string;
  saveStep: string;
  /** 참고 개수 문장이 가리킬 화면 이름. */
  screenName: string;
  /** "…한 <이름>은 N개입니다", "<이름>별 처리 결과"에 들어가는 리소스 이름. */
  itemName: string;
  /** "생성한 <주체> 자동 실행하지 말고"에 들어가는 말. */
  reviewSubject: string;
}> = {
  skill: {
    heading: "보관 스킬을 현재 OS용으로 일괄 마이그레이션하세요.",
    listStep: "먼저 get_skill_library를 호출해 migrationRequired가 true인 보관 스킬을 모두 나열하세요.",
    planStep: "각 스킬마다 get_skill_migration_plan을 현재 OS로 호출해 파일 목록과 변형 디렉터리를 확인하고, 필요한 원문은 read_common_skill_file로 읽으세요.",
    saveStep: "변경 파일은 계획이 알려준 variants overlay로, 대상 OS에서 제거할 base 파일·디렉터리는 deletes로 지정해 save_skill_platform_variant를 호출하세요. SKILL.md는 제거할 수 없습니다.",
    screenName: "스킬관리",
    itemName: "스킬",
    reviewSubject: "스크립트는",
  },
  instruction: {
    heading: "프로젝트 지침 원본을 현재 OS용으로 일괄 마이그레이션하세요.",
    listStep: "먼저 get_project_instruction_library를 호출해 currentPlatformSupported가 false인 지침을 모두 나열하세요.",
    planStep: "각 지침마다 get_project_instruction_migration_plan을 현재 OS로 호출해 대상 파일과 변형 디렉터리를 확인하고, 필요한 원문은 read_project_instruction_file로 읽으세요.",
    saveStep: "변경 파일은 계획이 알려준 변형으로 save_project_instruction_platform_variant를 호출해 저장하세요.",
    screenName: "지침관리",
    itemName: "지침",
    reviewSubject: "스크립트나 명령은",
  },
};

/**
 * 현재 OS에서 변형이 필요한 리소스 전체를 한 번에 마이그레이션하도록 AIA에게 요청한다.
 * 대상 열거와 항목별 계획 조회를 모두 typed API에 맡겨, 화면이 넘긴 개수는 참고값으로만
 * 쓰게 한다.
 */
function bulkMigrationPrompt(kind: BulkMigrationKind, count: number): string {
  const prompt = BULK_MIGRATION_PROMPTS[kind];
  const { screenName, itemName, reviewSubject } = prompt;
  return [
    prompt.heading,
    prompt.listStep,
    `현재 ${screenName} 화면 기준 변형이 필요한 ${itemName}은 ${count}개입니다. 이 숫자는 참고값이며 실제 조회 결과를 기준으로 작업하세요.`,
    prompt.planStep,
    prompt.saveStep,
    `생성한 ${reviewSubject} 자동 실행하지 말고 정적 검토 결과를 함께 설명하세요.`,
    `완료 후 ${itemName}별 처리 결과(성공·건너뜀·실패와 이유)를 요약하세요.`,
  ].join("\n");
}

/** 보관 스킬 일괄 마이그레이션 요청. */
export function skillBulkMigrationPrompt(count: number): string {
  return bulkMigrationPrompt("skill", count);
}

/** 프로젝트 지침 원본 일괄 마이그레이션 요청. */
export function instructionBulkMigrationPrompt(count: number): string {
  return bulkMigrationPrompt("instruction", count);
}
