/**
 * 이 장치의 앱 전역 상태 — 매니저 스냅숏, 저장 용량 개요, 스킬·지침 공통 저장소 경로,
 * 프로젝트 등록 목록, 승인된 폴더 생성 — 과 그 환경 안에서 읽어 오는 로컬 정의(에이전트·
 * 아티팩트) 조회.
 *
 * `ipc.ts`는 명령을 한 줄씩 얹은 목록에서 도메인별 `ipc*` 모듈로 갈라져 나왔지만, 이
 * 여덟 개만은 "화면 한 곳이 쓰는 묶음"이 아니라는 이유로 계속 남아 있었다(`ipcSkills`의
 * 머리말도 공통 저장소·프로젝트 목록을 두고 그렇게 적는다). 그래서 `ipc.ts`는 재수출
 * 목록과 명령 정의가 섞인 파일로 남았고, 배럴을 읽으러 온 사람은 그 사이에서 어디까지가
 * 재수출인지 눈으로 좇아야 했다. 쓰는 화면이 여럿이라는 것은 여기 모으지 못할 이유가
 * 아니라 여기 모을 이유다 — 이 명령들이 공유하는 것은 화면이 아니라 "이 장치"다.
 *
 * 스냅숏 조회는 응답에 `ipcSnapshot`의 기본값 보정을 이어 붙인다. 그 보정은 전송 모듈을
 * 들이지 않아야 단위 테스트가 파일 하나만 불러 돌 수 있으므로 저쪽에 남고, `call`을 타는
 * 이 두 줄만 여기 온다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type { AgentDetail, ArtifactDetail, DirectoryCreationPlan, ManagerSnapshot, ManagerSnapshotSync, ProjectRegistryEntry, ResourceRepositorySettings, SetProjectActiveRequest, SetResourceRepositoryRequest, StorageOverview } from "../types";
import { managerSnapshotSyncWithDefaults, managerSnapshotWithDefaults } from "./ipcSnapshot";
import { call } from "./ipcTransport";

export function getManagerSnapshot(): Promise<ManagerSnapshot> {
  return call<ManagerSnapshot>("get_manager_snapshot").then(managerSnapshotWithDefaults);
}

/**
 * 화면이 들고 있는 개정 이후의 변경분만 받는다. 백엔드가 그 개정을 기준으로 삼을 수 없으면
 * (첫 기동, 오래 끊겼던 창) 같은 호출이 전체 스냅숏을 돌려주므로 호출부는 둘 다 다뤄야 한다.
 */
export function getManagerSnapshotSync(sinceRevision: number): Promise<ManagerSnapshotSync> {
  return call<ManagerSnapshotSync>("get_manager_snapshot_delta", { sinceRevision })
    .then(managerSnapshotSyncWithDefaults);
}

export function getStorageOverview(): Promise<StorageOverview> {
  return call<StorageOverview>("get_storage_overview");
}

/** 스킬·프로젝트 지침 공통 저장소의 현재 장치 설정을 읽는다. */
export function getResourceRepository(): Promise<ResourceRepositorySettings> {
  return call<ResourceRepositorySettings>("get_resource_repository");
}

/** 공통 저장소 경로를 바꾸거나 앱 데이터 내부 기본 경로로 되돌린다. */
export function setResourceRepository(
  request: SetResourceRepositoryRequest,
): Promise<ResourceRepositorySettings> {
  return call<ResourceRepositorySettings>("set_resource_repository", { request });
}

/** 세션에서 확인한 프로젝트 전체와 이 장치의 활성 여부. 스냅샷은 제외 프로젝트를 이미 걷어낸 뒤라 따로 읽는다. */
export function getProjectRegistry(): Promise<ProjectRegistryEntry[]> {
  return call<ProjectRegistryEntry[]>("get_project_registry");
}

/** 프로젝트를 제외하거나 다시 켠다. 어느 쪽이든 새 프로젝트 결정 대기는 끝난다. 갱신된 목록을 돌려준다. */
export function setProjectActive(request: SetProjectActiveRequest): Promise<ProjectRegistryEntry[]> {
  return call<ProjectRegistryEntry[]>("set_project_active", { request });
}

/**
 * 만들기 전에 무엇이 생기는지 읽는다(C6-4b). 확인 대화는 `creates`를 그대로 나열하므로
 * 승인한 목록과 실제로 생기는 것이 어긋나지 않는다. 조회라 아무것도 만들지 않는다.
 */
export function previewDirectoryCreation(path: string): Promise<DirectoryCreationPlan> {
  return call<DirectoryCreationPlan>("preview_directory_creation", { request: { path } });
}

/**
 * 사용자가 확인 대화에서 승인한 폴더를 만든다. 이미 있는 폴더 아래로 없는 칸을 세 칸까지
 * 함께 만들고, 만든 정규 경로를 돌려준다. 원격 화면에서도 편집이 허용돼 있으면 실행된다.
 */
export function createDirectory(path: string): Promise<{ path: string }> {
  return call<{ path: string }>("create_directory", { request: { path } });
}

export function getAgentDetail(name: string): Promise<AgentDetail> {
  return call<AgentDetail>("get_agent_detail", { name });
}

export function getArtifactDetail(
  conversationId: string,
  rootName: string,
  name: string,
): Promise<ArtifactDetail> {
  return call<ArtifactDetail>("get_artifact_detail", {
    request: { conversationId, rootName, name },
  });
}
