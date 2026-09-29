import type { ModelCacheStatus, ProviderCliUpdateStatus } from "../types";

// 백엔드가 내려준 CLI 상태 한 건을 읽는 규칙 — 이 설치가 지금 어떤 상태이고, 캐시 기록이
// 무엇을 뜻하는지. 그 상태로 어떤 버튼을 누를 수 있고 어떤 구획을 여는지(cliUpdate.ts)와는
// 바뀌는 이유가 다르다. 상태 갈래는 CLI가 버전·캐시를 알리는 방식이 바뀔 때 늘고, 버튼과
// 구획은 원격 권한이나 화면 구성이 바뀔 때 손댄다.

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

/**
 * 이 공급자의 CLI 실행 파일을 찾았는지. 배지·버튼·상단 알림이 모두 "탐지되지 않았으면
 * 그 앞의 판정은 성립하지 않는다"를 맨 먼저 보는데, 세 모듈이 저마다 `executablePath`를
 * 직접 읽어 `Boolean(...)`과 `!...`로 뒤집어 적고 있었다. 무엇을 탐지로 볼지는 백엔드가
 * 실행 파일을 알리는 방식이 바뀔 때 손대는 상태 읽기 규칙이므로 이 모듈에서만 정한다.
 */
export function cliDetected(status: ProviderCliUpdateStatus): boolean {
  return Boolean(status.executablePath);
}

/**
 * 버전 정보를 읽지 못했는지. 최신 버전 조회 실패와 실행 버전 읽기 실패는 원인이 다르지만
 * (네트워크 / 로컬 실행 파일) "업데이트가 필요한지 판단할 수 없다"는 결론이 같아, 상단
 * 알림은 둘을 한 갈래로 모은다. 배지는 두 원인을 갈라 보여야 하므로 이 판정을 쓰지 않는다.
 */
export function versionCheckFailed(status: ProviderCliUpdateStatus): boolean {
  return Boolean(status.checkError) || Boolean(status.versionError);
}

/**
 * 실행 중인 CLI의 버전을 읽었는지. 실행 파일은 있는데 `--version`이 실패했거나 값이
 * 비어 있으면, 최신 버전을 알아도 비교 자체가 성립하지 않는다(QA #54).
 */
function runningVersionKnown(status: ProviderCliUpdateStatus): boolean {
  return Boolean(status.currentVersion) && !status.versionError;
}

export function cliUpdateBadge(status: ProviderCliUpdateStatus): CliUpdateBadge {
  if (!cliDetected(status)) return "notDetected";
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
 * 지울 수 있는 캐시가 하나라도 있는지. 정리 버튼과 상단 알림이 같은 기준을 본다.
 * 두 쪽이 서로 다른 이유로 고쳐지는 자리에 있으므로, 기준 자체는 상태를 읽는 이곳에 둔다.
 */
export function hasModelCacheCleanupTargets(status: ProviderCliUpdateStatus): boolean {
  return status.modelCaches.some((cache) => cache.cleanupAvailable);
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
