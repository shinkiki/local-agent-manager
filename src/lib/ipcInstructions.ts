/**
 * 프로젝트 지침(공통 원본·배포본·정리폴더) 명령 묶음.
 *
 * `ipc.ts`는 백엔드 명령 하나하나를 얹은 1200줄짜리 목록이라, 한 영역의 명령을 찾으려면
 * 관계 없는 영역 사이를 훑어야 했다. 지침은 공통 원본과 배포본이라는 자기 개념을 가진
 * 영역이고 화면도 `InstructionsView` 한 곳에서 쓰므로, 그 명령들을 여기 모은다.
 *
 * `ipc.ts`가 이 파일의 이름을 그대로 다시 내보내므로 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type { HostPlatform, LinkedFile, ProviderId } from "../types";
import type { CreateProjectInstructionRequest, DeployedInstructionFileContent, ImportProjectInstructionRequest, InstructionDeleteCheckRequest, InstructionDeleteImpact, InstructionDeleteReceipt, InstructionDeploymentLinkRequest, InstructionImportPreview, InstructionImportPreviewRequest, InstructionPublishReceipt, InstructionSyncReceipt, InstructionTrashOverview, InstructionTrashRestoreReceipt, InstructionUpdateReceipt, ProjectInstructionEntry, ProjectInstructionFileContent, ProjectInstructionLibrary, ProjectInstructionMigrationPlan, PublishProjectInstructionRequest, SetProjectInstructionPlatformsRequest, SyncProjectInstructionRequest, UpdateProjectInstructionRequest } from "../types";
import { userConfirmedDeleteRequest } from "./ipcDeletion";
import { call } from "./ipcTransport";

/** 지침이 놓이는 자리의 범위. 개인 설정 한 벌이거나 등록된 프로젝트 하나다. */
export type InstructionScope = "personal" | "project";

/**
 * 배포된 지침 파일 하나를 가리키는 세 값. 배포 삭제·원문 열람·링크 파일 조회·내려받기가
 * 모두 같은 셋을 같은 순서로 받는데, 네 자리가 각자 `"personal" | "project"`를 다시 적고
 * 봉투도 손으로 조립하고 있었다. 범위 낱말이 한 자리만 늘어나도 나머지 세 자리는 그대로
 * 통과하고, 필드 이름을 하나 잘못 적으면 타입은 지나고 백엔드에서 인자 부족으로만 드러난다.
 * 이름과 조립을 한곳에 둔다.
 */
export type DeployedInstructionRef = {
  scope: InstructionScope;
  projectPath: string | null;
  provider: ProviderId;
};

export function deployedInstructionRef(
  scope: InstructionScope,
  projectPath: string | null,
  provider: ProviderId,
): DeployedInstructionRef {
  return { scope, projectPath, provider };
}

export function getProjectInstructionLibrary(): Promise<ProjectInstructionLibrary> {
  return call<ProjectInstructionLibrary>("get_project_instruction_library");
}

export function getProjectInstructionMigrationPlan(
  key: string,
  targetPlatform: HostPlatform,
): Promise<ProjectInstructionMigrationPlan> {
  return call<ProjectInstructionMigrationPlan>("get_project_instruction_migration_plan", { key, targetPlatform });
}

export function readProjectInstructionFile(
  key: string,
  provider: ProviderId,
): Promise<ProjectInstructionFileContent> {
  return call<ProjectInstructionFileContent>("read_project_instruction_file", { key, provider });
}

export function createProjectInstruction(
  request: CreateProjectInstructionRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("create_project_instruction", { request });
}

export function importProjectInstruction(
  request: ImportProjectInstructionRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("import_project_instruction", { request });
}

/** 가져오기 전에 지침이 링크로 끌고 오는 문서를 훑는다. 파일을 쓰지 않는 읽기 작업이다. */
export function previewProjectInstructionImport(
  request: InstructionImportPreviewRequest,
): Promise<InstructionImportPreview> {
  return call<InstructionImportPreview>("preview_project_instruction_import", { request });
}

export function publishProjectInstruction(
  request: PublishProjectInstructionRequest,
): Promise<InstructionPublishReceipt> {
  return call<InstructionPublishReceipt>("publish_project_instruction", { request });
}

export function setProjectInstructionPlatforms(
  request: SetProjectInstructionPlatformsRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("set_project_instruction_platforms", { request });
}

/** 지침 삭제 전 영향 확인. 파일을 쓰지 않는 읽기 작업이다. */
export function checkProjectInstructionDelete(
  request: InstructionDeleteCheckRequest,
): Promise<InstructionDeleteImpact> {
  // 이 명령만 봉투 없이 칸을 그대로 편다. 인터페이스는 색인 서명이 없어 `call`의 인자
  // 자리에 바로 놓이지 않는데, 캐스트로 열면 칸 이름을 잘못 적어도 통과한다. 펼침은
  // 같은 모양을 만들면서 칸 이름은 타입이 계속 본다.
  return call<InstructionDeleteImpact>("check_project_instruction_delete", { ...request });
}

export function deleteProjectInstructionDeployment(
  scope: InstructionScope,
  projectPath: string | null,
  provider: ProviderId,
): Promise<InstructionDeleteReceipt> {
  return call<InstructionDeleteReceipt>(
    "delete_project_instruction_deployment",
    userConfirmedDeleteRequest(deployedInstructionRef(scope, projectPath, provider)),
  );
}

export function deleteSharedProjectInstruction(key: string): Promise<InstructionDeleteReceipt> {
  return call<InstructionDeleteReceipt>(
    "delete_shared_project_instruction",
    userConfirmedDeleteRequest({ key }),
  );
}

/** 보관만 취소한다. 배포된 지침 파일은 그 자리에 남고 원본만 휴지통으로 간다. */
export function unarchiveSharedProjectInstruction(key: string): Promise<InstructionDeleteReceipt> {
  return call<InstructionDeleteReceipt>(
    "unarchive_shared_project_instruction",
    userConfirmedDeleteRequest({ key }),
  );
}

/** 그 위치에 이미 있는 지침 파일을 이 원본의 배포로 등록한다. 파일은 그대로 둔다. */
export function attachProjectInstructionDeployment(
  request: InstructionDeploymentLinkRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("attach_project_instruction_deployment", { request });
}

/** 배포 등록만 해제한다. 파일은 그 자리에 남는다. */
export function detachProjectInstructionDeployment(
  request: InstructionDeploymentLinkRequest,
): Promise<ProjectInstructionEntry> {
  return call<ProjectInstructionEntry>("detach_project_instruction_deployment", { request });
}

export function syncProjectInstructionFromDeployment(
  request: SyncProjectInstructionRequest,
): Promise<InstructionSyncReceipt> {
  return call<InstructionSyncReceipt>("sync_project_instruction_from_deployment", { request });
}

export function updateProjectInstruction(
  request: UpdateProjectInstructionRequest,
): Promise<InstructionUpdateReceipt> {
  return call<InstructionUpdateReceipt>("update_project_instruction", { request });
}

export function setProjectInstructionAutoSync(key: string, autoSync: boolean): Promise<void> {
  return call<void>("set_project_instruction_auto_sync", { key, autoSync });
}

export function listInstructionTrash(): Promise<InstructionTrashOverview> {
  return call<InstructionTrashOverview>("list_instruction_trash");
}

export function restoreInstructionTrash(id: string): Promise<InstructionTrashRestoreReceipt> {
  return call<InstructionTrashRestoreReceipt>("restore_instruction_trash", { id });
}

export function purgeInstructionTrash(id?: string): Promise<number> {
  return call<number>("purge_instruction_trash", { id: id ?? null });
}

/** 개인 설정·프로젝트에 실제 배포된 지침 파일 원문 열람. */
export function readDeployedInstructionFile(
  scope: InstructionScope,
  projectPath: string | null,
  provider: ProviderId,
): Promise<DeployedInstructionFileContent> {
  return call<DeployedInstructionFileContent>(
    "read_deployed_instruction_file",
    deployedInstructionRef(scope, projectPath, provider),
  );
}

/**
 * 배포된 지침이 `@경로`로 가져오거나 링크한 문서 하나를 가리키는 요청 본문. currentPath는
 * 링크를 만난 문서의 배포 루트 기준 상대 경로로, 비우면 지침 파일 자신을 기준으로 삼는다.
 *
 * `deployedInstructionRef`가 배포 자리 셋을 모았지만 링크 두 칸은 그 밖에 남아, 읽는
 * 자리와 내려받는 자리(`ipcLinkedFile`)가 다섯 값을 각자 같은 순서로 받아 각자 조립하고
 * 있었다. 한쪽만 칸이 늘어도 타입은 지나므로 봉투 전체를 여기 한 벌만 둔다.
 */
export type DeployedInstructionLinkedFileRef = DeployedInstructionRef & {
  currentPath: string | null;
  href: string;
};

export function deployedInstructionLinkedFileRef(
  scope: InstructionScope,
  projectPath: string | null,
  provider: ProviderId,
  currentPath: string | null,
  href: string,
): DeployedInstructionLinkedFileRef {
  return { ...deployedInstructionRef(scope, projectPath, provider), currentPath, href };
}

export function getDeployedInstructionLinkedFile(
  scope: InstructionScope,
  projectPath: string | null,
  provider: ProviderId,
  currentPath: string | null,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_deployed_instruction_linked_file", {
    request: deployedInstructionLinkedFileRef(scope, projectPath, provider, currentPath, href),
  });
}
