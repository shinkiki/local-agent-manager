import type { ModelCacheStatus, ProviderCliUpdateStatus, ProviderId } from "../types";

/**
 * 공급자 카드에 표시할 업데이트 상태. 실제 업데이트 가능 여부와 최신 버전 확인
 * 실패, 실행 버전 확인 실패, 자동 업데이트 미지원을 서로 다른 상태로 구분한다.
 */
export type CliUpdateBadge =
  | "notDetected"
  | "updateAvailable"
  | "versionUnknown"
  | "checkFailed"
  | "upToDate"
  | "unsupported"
  | "checkUnsupported"
  | "unchecked";

export interface CliActionAccess {
  /** 변경 권한이 있는지. 원격은 write 모드일 때만 확인·업데이트·캐시 정리를 실행한다. */
  writable: boolean;
  busy?: boolean;
}

/**
 * 실행 중인 CLI의 버전을 읽었는지. 실행 파일은 있는데 `--version`이 실패했거나 값이
 * 비어 있으면, 최신 버전을 알아도 비교 자체가 성립하지 않는다(QA #54).
 */
function runningVersionKnown(status: ProviderCliUpdateStatus): boolean {
  return Boolean(status.currentVersion) && !status.versionError;
}

export function cliUpdateBadge(status: ProviderCliUpdateStatus): CliUpdateBadge {
  if (!status.executablePath) return "notDetected";
  if (status.updateAvailable) return "updateAvailable";
  // 실행 버전을 모르면 "최신"이라고 말할 근거가 없다. 최신 버전 조회 실패와도
  // 원인이 다르므로(네트워크가 아니라 로컬 실행 파일) 따로 알린다.
  if (!runningVersionKnown(status)) return "versionUnknown";
  if (status.checkError) return "checkFailed";
  if (status.checked && status.latestVersion) return "upToDate";
  if (!status.updateSupported) return "unsupported";
  if (!status.checkSupported) return "checkUnsupported";
  return "unchecked";
}

/**
 * 확인·업데이트·캐시 정리가 공통으로 요구하는 권한. 셋 다 백엔드를 바꾸는 작업이라
 * 원격에서는 write 모드여야 하고, 이미 다른 작업이 도는 동안에는 누를 수 없다.
 */
function actionAllowed(access: CliActionAccess): boolean {
  return access.writable && !access.busy;
}

/** 원격 편집이 꺼져 있어 막힌 경우의 안내. 세 작업이 같은 문구를 쓴다. */
const REMOTE_WRITE_BLOCKED = "원격 변경이 비활성화되어 있습니다.";

/** 최신 버전 확인 버튼을 누를 수 있는지. 원격에서도 write 권한이 있으면 조회한다. */
export function canCheckCliUpdate(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return Boolean(status.executablePath) && status.checkSupported && actionAllowed(access);
}

export function canRunCliUpdate(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return Boolean(status.executablePath) && status.updateSupported && actionAllowed(access);
}

/** 업데이트를 실행할 수 없는 이유. 실행 가능하면 null. */
export function cliUpdateBlockedReason(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): string | null {
  if (!status.executablePath) return "CLI 실행 파일이 탐지되지 않았습니다.";
  if (!status.updateSupported) {
    return status.unsupportedReason ?? "자동 업데이트를 지원하지 않는 설치입니다.";
  }
  if (!access.writable) return REMOTE_WRITE_BLOCKED;
  return null;
}

export function modelCacheCleanupTargets(status: ProviderCliUpdateStatus) {
  return status.modelCaches.filter((cache) => cache.cleanupAvailable);
}

/** 지울 수 있는 캐시가 하나라도 있는지. 정리 버튼과 상단 알림이 같은 기준을 본다. */
function hasModelCacheCleanupTargets(status: ProviderCliUpdateStatus): boolean {
  return status.modelCaches.some((cache) => cache.cleanupAvailable);
}

export function canClearModelCaches(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return hasModelCacheCleanupTargets(status) && actionAllowed(access);
}

/** 캐시 정리를 제공할 수 없는 이유. 제공 가능하면 null. */
export function modelCacheBlockedReason(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): string | null {
  if (status.modelCaches.length === 0) {
    return status.modelCacheUnsupportedReason ?? "이 공급자는 자동 캐시 정리를 지원하지 않습니다.";
  }
  if (!hasModelCacheCleanupTargets(status)) return null;
  if (!access.writable) return REMOTE_WRITE_BLOCKED;
  return null;
}

/**
 * 실행 CLI보다 새 클라이언트가 기록한 캐시인데 배포된 최신 CLI까지 이미 설치된
 * 상태인지. 이때는 업데이트로 해결할 수 없으므로 새 CLI 배포를 기다리라고
 * 안내해야 한다. 버전 비교는 백엔드가 이미 끝냈다. `mismatched`는 기록 버전이 실행
 * 버전보다 높을 때만 붙고, 낮은 쪽은 `outdated`로 따로 오므로 여기서 다시 비교하지
 * 않는다(프리릴리스 취급이 백엔드와 어긋나는 것을 막는다). 실행 버전을 읽지 못한
 * 상태에서는 "이미 최신"을 단정할 수 없으므로 해당하지 않는다.
 */
export function cacheAwaitsNewerCliRelease(
  status: ProviderCliUpdateStatus,
  cache: ModelCacheStatus,
): boolean {
  // 실행 버전을 못 읽었으면 "이미 최신"이라는 전제가 서지 않는다(QA #54).
  return cache.state === "mismatched" && runningVersionKnown(status) && status.checked && !status.updateAvailable;
}

export interface CliUpdateAlert {
  /** 최신 버전이 확인되어 업데이트가 가능한 공급자. */
  updatable: ProviderId[];
  /** 캐시 기록 버전이 실행 버전보다 높아 스키마 불일치가 의심되는 공급자. */
  cacheMismatched: ProviderId[];
  /** 현재 또는 최신 버전을 읽지 못해 업데이트 필요 여부를 판단할 수 없는 공급자. */
  checkFailed: ProviderId[];
}

/**
 * 설정 화면 상단 알림 근거. 업데이트 가능, 캐시 스키마 불일치, 버전 확인 실패는
 * 원인과 해결 방법이 다르므로 하나로 합치지 않는다.
 */
export function cliUpdateAlert(statuses: ProviderCliUpdateStatus[]): CliUpdateAlert {
  return {
    updatable: statuses.filter((status) => status.updateAvailable).map((status) => status.provider),
    cacheMismatched: statuses
      .filter(hasModelCacheCleanupTargets)
      .map((status) => status.provider),
    checkFailed: statuses
      .filter((status) => Boolean(status.executablePath) && (Boolean(status.checkError) || Boolean(status.versionError)))
      .map((status) => status.provider),
  };
}

export function hasCliUpdateAlert(alert: CliUpdateAlert): boolean {
  return cliUpdateAlertProviders(alert).length > 0;
}

/** 알림 근거가 있는 공급자 목록. 같은 공급자가 여러 근거에 들어가도 한 번만 담는다. */
function cliUpdateAlertProviders(alert: CliUpdateAlert): ProviderId[] {
  return [...new Set([...alert.updatable, ...alert.cacheMismatched, ...alert.checkFailed])];
}

/** 업데이트 구획을 여는 동안 진행 중이거나 남아 있는 작업 상태. */
export interface CliUpdatePanelActivity {
  /** 이 공급자의 확인·업데이트·캐시 정리가 진행 중인지. */
  busy: boolean;
  /** 마지막 작업의 결과 안내나 오류가 아직 남아 있는지. */
  hasMessage: boolean;
  /** 종료 확인창이 열려 있는지. */
  pending: boolean;
}

/**
 * 공급자 카드에 업데이트 구획을 그릴지. 평상시(최신 버전·확인 미지원)에는 접어 두고
 * 상단 알림에 근거가 있는 공급자에서만 알림과 함께 연다. 진행 중인 작업과 방금 끝난
 * 작업의 결과는 알림 근거가 사라진 뒤에도 사용자가 읽을 수 있어야 하므로 함께 남긴다.
 */
export function shouldShowCliUpdatePanel(
  status: ProviderCliUpdateStatus,
  alert: CliUpdateAlert,
  activity: CliUpdatePanelActivity,
): boolean {
  if (activity.busy || activity.hasMessage || activity.pending) return true;
  return cliUpdateAlertProviders(alert).includes(status.provider);
}

/** 종료 확인이 필요한 대상 수. 0이면 확인창 없이 진행할 수 있다. */
export function runtimeStopConfirmationCount(counts: {
  chatCount: number;
  terminalCount: number;
  externalProcessCount: number;
}): number {
  return counts.chatCount + counts.terminalCount + counts.externalProcessCount;
}
