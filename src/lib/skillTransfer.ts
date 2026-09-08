export type RepositoryTransferKind = "backup" | "restore";

export function isUserSkillCandidate(scope: string): boolean {
  return scope === "personal" || scope === "project";
}

/**
 * 장치별로 설정된 공통 리소스 저장소(스킬 원본 + 프로젝트 지침 원본)를 백업·복구하도록
 * AIA에게 요청한다. 경로를 프롬프트에 고정하지 않고 typed 조회 결과를 사용하게 한다.
 */
export function repositoryTransferPrompt(kind: RepositoryTransferKind): string {
  const common = [
    "먼저 get_resource_repository를 호출해 현재 장치의 rootPath와 skillsPath, instructionsPath를 확인하세요. 대상은 그 공통 저장소의 skills·instructions 하위 전체이며, 다른 경로나 예전 ~/.agents/skills를 추측해서 사용하지 마세요.",
    "skills 아래 각 하위 디렉터리가 보관 스킬 하나이며 SKILL.md, .agent-manager OS 메타데이터·변형, scripts, references, assets 등 구성 파일 전체를 보존해야 합니다. instructions 아래 각 하위 디렉터리가 지침 원본 하나이며 공급자별 지침 파일과 연결 문서, .agent-manager 메타를 함께 보존해야 합니다.",
    "에이전트 스킬 루트(~/.claude/skills, ~/.codex/skills, ~/.gemini/config/skills), 예전 ~/.agents/.skill-lock.json, 공급자 캐시·인증·설정·세션, 채팅·계정 데이터는 포함하거나 변경하지 마세요.",
    "비밀값으로 보이는 파일이나 내용은 백업·복구하지 말고 사용자에게 알리되 실제 비밀값은 출력하지 마세요.",
  ];

  if (kind === "backup") {
    return [
      "스킬·지침 공통 저장소 백업을 도와주세요.",
      ...common,
      "백업 저장 위치를 먼저 사용자에게 확인하세요. 확인 전에는 파일을 생성하거나 변경하지 마세요.",
      "확인 후 이식 가능한 백업(디렉터리 사본 또는 압축)을 만들고, 리소스 키·상대 경로·파일 해시·실행 권한을 담은 비밀값 없는 manifest를 함께 넣으세요.",
      "완료 후 백업 위치, 포함/제외한 스킬·지침 수, 주의사항과 검증 결과를 요약하세요.",
    ].join("\n");
  }

  return [
    "스킬·지침 공통 저장소 복구를 도와주세요.",
    ...common,
    "복구할 백업 위치와 기존 보관 원본과의 충돌 처리 방식을 먼저 사용자에게 확인하세요. 확인 전에는 파일을 생성·덮어쓰기·삭제하지 마세요.",
    "manifest와 파일 해시를 검증한 뒤 get_resource_repository가 반환한 skillsPath·instructionsPath 아래로 복원하세요. 기존 보관 원본은 명시적 승인 없이 덮어쓰지 말고, 백업에 없는 파일을 삭제하지 마세요.",
    "복구 후에는 스킬관리 화면에서 각 에이전트의 사용 여부를, 지침관리 화면에서 게시 위치를 다시 켜야 배포된다는 점을 사용자에게 안내하세요.",
    "완료 후 복원된 스킬·지침 수, 충돌 처리, 검증 결과를 요약하세요.",
  ].join("\n");
}

/**
 * 현재 OS에서 변형이 필요한 보관 스킬 전체를 한 번에 마이그레이션하도록 AIA에게
 * 요청한다. 대상 열거와 항목별 계획 조회를 모두 typed API에 맡겨, 화면이 넘긴 개수는
 * 참고값으로만 쓰게 한다.
 */
export function skillBulkMigrationPrompt(count: number): string {
  const shared = bulkMigrationPolicyLines(count, "스킬관리", "스킬", "스크립트는");
  return [
    "보관 스킬을 현재 OS용으로 일괄 마이그레이션하세요.",
    "먼저 get_skill_library를 호출해 migrationRequired가 true인 보관 스킬을 모두 나열하세요.",
    shared.countNotice,
    "각 스킬마다 get_skill_migration_plan을 현재 OS로 호출해 파일 목록과 변형 디렉터리를 확인하고, 필요한 원문은 read_common_skill_file로 읽으세요.",
    "변경 파일은 계획이 알려준 variants overlay로, 대상 OS에서 제거할 base 파일·디렉터리는 deletes로 지정해 save_skill_platform_variant를 호출하세요. SKILL.md는 제거할 수 없습니다.",
    shared.reviewNotice,
    shared.resultNotice,
  ].join("\n");
}

/**
 * 현재 OS를 지원하지 않는 프로젝트 지침 전체를 한 번에 마이그레이션하도록 AIA에게
 * 요청한다. 스킬 쪽과 같은 구조로, 열거·계획·저장 모두 typed API를 쓰게 한다.
 */
export function instructionBulkMigrationPrompt(count: number): string {
  const shared = bulkMigrationPolicyLines(count, "지침관리", "지침", "스크립트나 명령은");
  return [
    "프로젝트 지침 원본을 현재 OS용으로 일괄 마이그레이션하세요.",
    "먼저 get_project_instruction_library를 호출해 currentPlatformSupported가 false인 지침을 모두 나열하세요.",
    shared.countNotice,
    "각 지침마다 get_project_instruction_migration_plan을 현재 OS로 호출해 대상 파일과 변형 디렉터리를 확인하고, 필요한 원문은 read_project_instruction_file로 읽으세요.",
    "변경 파일은 계획이 알려준 변형으로 save_project_instruction_platform_variant를 호출해 저장하세요.",
    shared.reviewNotice,
    shared.resultNotice,
  ].join("\n");
}

/**
 * 일괄 마이그레이션 두 갈래가 공유하는 안전 지시. 리소스별 typed API 단계는 각
 * 프롬프트에 두고, 참고 개수·정적 검토·항목별 결과 문구만 한 곳에서 맞춘다.
 */
function bulkMigrationPolicyLines(
  count: number,
  screenName: string,
  itemName: string,
  reviewSubject: string,
) {
  return {
    countNotice: `현재 ${screenName} 화면 기준 변형이 필요한 ${itemName}은 ${count}개입니다. 이 숫자는 참고값이며 실제 조회 결과를 기준으로 작업하세요.`,
    reviewNotice: `생성한 ${reviewSubject} 자동 실행하지 말고 정적 검토 결과를 함께 설명하세요.`,
    resultNotice: `완료 후 ${itemName}별 처리 결과(성공·건너뜀·실패와 이유)를 요약하세요.`,
  };
}
