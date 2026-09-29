/**
 * 스킬(공통 원본·설치본·휴지통) 명령 묶음.
 *
 * `ipc.ts`는 백엔드 명령 하나하나를 얹은 800줄짜리 목록이라, 스킬 명령을 찾으려면 세션·
 * 일정·문서 사이에 흩어진 스무 개를 훑어야 했다. 실제로 스킬 명령은 `getSkillDetail`부터
 * 휴지통까지 한 덩어리인데도 그 사이에 공통 저장소 설정·프로젝트 목록·AIA 제안 카탈로그가
 * 끼어 있어 경계가 보이지 않았다. 지침(`ipcInstructions`)·애드온 도구(`ipcCypress` 등)과 같은 규칙으로
 * 이 묶음을 따로 낸다.
 *
 * 공통 저장소 설정과 프로젝트 목록은 스킬 전용이 아니라 지침도 함께 쓰므로 이 장치의 작업
 * 환경을 모은 `ipcWorkspace`가 가지고, AIA 제안 카탈로그도 스킬 팩을 읽지만 쓰는 쪽이 AIA라
 * `ipcChat`에 있다.
 *
 * `ipc.ts`가 이 파일의 이름을 그대로 다시 내보내므로 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type { CommonSkillDetail, CommonSkillDigest, CommonSkillSource, HostPlatform, ProviderId, SetSkillPlatformsRequest, SkillDeleteReceipt, SkillDetail, SkillFileContent, SkillFileWrite, SkillInstallComparison, SkillLibrary, SkillLocation, SkillMigrationPlan, SkillOverwritePolicy, SkillPublishReceipt, SkillSyncReceipt, SkillTrashOverview, SkillTrashRestoreReceipt, SkillUpdateReceipt } from "../types";
import { userActorRequest, userConfirmedDeleteRequest } from "./ipcDeletion";
import { call } from "./ipcTransport";

export function getSkillDetail(id: string): Promise<SkillDetail> {
  return call<SkillDetail>("get_skill_detail", { id });
}

/**
 * 통합 스킬 라이브러리를 읽는다. 공통 원본과 공급자별 노출 상태를 한 번에 돌려주고,
 * 파일시스템에서 매번 새로 계산하므로 별도 갱신 호출이 필요 없다.
 */
export function getSkillLibrary(): Promise<SkillLibrary> {
  return call<SkillLibrary>("get_skill_library");
}

/** 현재 원본을 지정한 OS용으로 옮길 때 AIA가 따라야 할 정적 마이그레이션 계획. */
export function getSkillMigrationPlan(
  key: string,
  targetPlatform: HostPlatform,
): Promise<SkillMigrationPlan> {
  return call<SkillMigrationPlan>("get_skill_migration_plan", { key, targetPlatform });
}

/** 스킬 base 원본의 지원 OS 메타데이터를 낙관적 잠금으로 저장한다. */
export function setSkillPlatforms(
  request: SetSkillPlatformsRequest,
): Promise<SkillUpdateReceipt> {
  return call<SkillUpdateReceipt>("set_skill_platforms", { request });
}

/** 공통 원본의 내용 지문만 읽는 축약 조회. 스킬 변경 감지 폴링에 쓴다. */
export function getCommonSkillDigests(): Promise<CommonSkillDigest[]> {
  return call<CommonSkillDigest[]>("get_common_skill_digests");
}

export function getCommonSkillDetail(key: string): Promise<CommonSkillDetail> {
  return call<CommonSkillDetail>("get_common_skill_detail", { key });
}

/**
 * 공통 원본을 새로 만들 때 보내는 값. Core `CreateCommonSkillRequest`와 짝이다.
 *
 * 이 모듈의 다른 명령은 요청 모양을 이름으로 받는데(`SetSkillPlatformsRequest` 등) 공통
 * 원본을 만들고·배포하고·고치는 셋만 인자 자리에 모양을 그대로 적고 있었다. 이름이 없으면
 * 화면이 그 값을 조립하는 동안 들고 다닐 타입이 없어, 필드를 늘릴 때 호출부마다 무엇이
 * 필수인지 다시 읽어야 한다. Core에 이미 있는 이름을 그대로 쓴다.
 */
export interface CreateCommonSkillRequest {
  key: string;
  name?: string | null;
  description: string;
}

export function createCommonSkill(request: CreateCommonSkillRequest): Promise<CommonSkillSource> {
  return call<CommonSkillSource>("create_common_skill", { request });
}

/** 공급자 사용자 스킬을 공통 원본으로 승격한다. 원본 설치본은 그대로 남는다. */
export function importSkillToCommon(skillId: string): Promise<CommonSkillSource> {
  return call<CommonSkillSource>("import_skill_to_common", { request: { skillId } });
}

/** 공통 원본을 공급자 위치에 배포할 때 보내는 값. Core `SkillPublishRequest`와 짝이다. */
export interface SkillPublishRequest {
  key: string;
  providers: ProviderId[];
  overwrite?: SkillOverwritePolicy;
  /** 배포 위치. 생략하면 개인 루트. */
  location?: SkillLocation;
}

export function publishCommonSkill(request: SkillPublishRequest): Promise<SkillPublishReceipt> {
  return call<SkillPublishReceipt>("publish_common_skill", { request });
}

/** 외부에서 수정된 설치본을 새 보관 원본으로 채택하고 나머지 사용 위치에 재배포한다. */
export function syncSkillFromInstall(skillId: string): Promise<SkillSyncReceipt> {
  return call<SkillSyncReceipt>("sync_skill_from_install", userActorRequest({ skillId }));
}

/** 외부 수정이 감지된 설치본과 보관 원본의 파일별 차이. 읽기 전용이다. */
export function compareSkillInstall(skillId: string): Promise<SkillInstallComparison> {
  return call<SkillInstallComparison>("compare_skill_install", { request: { skillId } });
}

/** 보관 원본 편집에 보내는 값. Core `UpdateCommonSkillRequest`와 짝이다. */
export interface UpdateCommonSkillRequest {
  key: string;
  files: SkillFileWrite[];
  deletes: string[];
  /** 낙관적 잠금. 현재 원본 내용 지문과 다르면 백엔드가 거절한다. */
  expectedDigest: string;
}

/** 보관 원본 편집. 저장 즉시 모든 사용 위치에 재배포된다. */
export function updateCommonSkill(request: UpdateCommonSkillRequest): Promise<SkillUpdateReceipt> {
  return call<SkillUpdateReceipt>("update_common_skill", { request });
}

export function readCommonSkillFile(key: string, path: string): Promise<SkillFileContent> {
  return call<SkillFileContent>("read_common_skill_file", { key, path });
}

export function setSkillAutoSync(key: string, autoSync: boolean): Promise<void> {
  return call<void>("set_skill_auto_sync", { key, autoSync });
}

/** 에이전트 위치의 스킬 설치본을 확정 삭제한다. 실체는 휴지통으로 이동한다. */
export function deleteSkill(id: string): Promise<SkillDeleteReceipt> {
  return call<SkillDeleteReceipt>("delete_skill", userConfirmedDeleteRequest({ id }));
}

/** 공유 스킬을 원본과 모든 배포본까지 한 그룹으로 삭제한다. 휴지통에서 그룹 단위로 복구한다. */
export function deleteSharedSkill(key: string): Promise<SkillDeleteReceipt> {
  return call<SkillDeleteReceipt>("delete_shared_skill", userConfirmedDeleteRequest({ key }));
}

/** 보관만 취소한다. 에이전트 사용본은 그대로 남고 보관 원본만 휴지통으로 간다. */
export function unarchiveSharedSkill(key: string): Promise<SkillDeleteReceipt> {
  return call<SkillDeleteReceipt>("unarchive_shared_skill", userConfirmedDeleteRequest({ key }));
}

export function listSkillTrash(): Promise<SkillTrashOverview> {
  return call<SkillTrashOverview>("list_skill_trash");
}

/** 휴지통 항목을 원래 경로로 복구한다. 그룹에 속한 항목이면 그룹 전체를 복구한다. */
export function restoreSkillTrash(id: string): Promise<SkillTrashRestoreReceipt> {
  return call<SkillTrashRestoreReceipt>("restore_skill_trash", { id });
}

/** 휴지통 비우기. id를 생략하면 전체를 지운다. 지운 항목 수를 돌려준다. */
export function purgeSkillTrash(id?: string): Promise<number> {
  return call<number>("purge_skill_trash", { id: id ?? null });
}
