import type {
  SessionCleanupPolicy,
  SessionCleanupReceipt,
  SessionCleanupStatus,
} from "../types";

/**
 * 세션 자동정리 카드가 쓰는 판정 — 지금 이 버튼을 누를 수 있는가, 그리고 누를 수 없다면
 * 무엇 때문인가.
 *
 * 조건 계산 자체는 백엔드가 한다 — 미리보기와 실제 실행이 갈라지지 않으려면 판정이 한
 * 곳에만 있어야 한다. 받은 숫자를 어떻게 읽어 주는지는 `sessionCleanupText.ts`가 맡고,
 * 카드 하나가 둘을 함께 쓰므로 그 문구는 여기서 다시 내보낸다.
 */

export {
  formatBytes,
  previewSummary,
  reasonHint,
  receiptSummary,
  shrinkFactor,
} from "./sessionCleanupText.ts";

export interface CleanupAccess {
  /** 변경 권한. 원격은 write 모드일 때만 조건 저장·실행을 받는다. */
  writable: boolean;
  busy?: boolean;
}

const REMOTE_WRITE_BLOCKED = "원격 변경이 비활성화되어 있습니다.";

function actionAllowed(access: CleanupAccess): boolean {
  return access.writable && !access.busy;
}

/**
 * 자동정리 실행 여부를 판정하는 조건 필드 목록.
 *
 * `enabled`, `intervalHours`, `trashRetentionDays` 같은 주기·보관 옵션과 달리,
 * 이 다섯 값 중 하나라도 설정되어 있어야(null이 아니어야) 실제 정리할 대상이 생긴다.
 */
export const CLEANUP_CONDITION_KEYS = [
  "retentionDays",
  "maxMessageCount",
  "perProviderCap",
  "perAutomationCap",
  "hiddenAfterDays",
] as const satisfies readonly (keyof SessionCleanupPolicy)[];


/** 조건이 하나라도 켜져 있는지. 하나도 없으면 자동정리를 켤 수 없다. */
export function hasAnyCondition(policy: SessionCleanupPolicy): boolean {
  return CLEANUP_CONDITION_KEYS.some((key) => policy[key] !== null);
}

/**
 * 지금 정리를 실행할 수 없는 사유. 실행할 수 있으면 null이다.
 *
 * 버튼의 비활성 여부와 그 옆에 적는 사유가 각자 조건을 적고 있었다. 같은 세 조건을 한쪽은
 * `&&`로 이어 적고 다른 쪽은 이른 반환으로 갈라 적어, 조건을 하나 늘리면 두 모양을 각각
 * 고쳐야 했고 그중 한쪽만 고치면 누를 수 있는데 사유가 붙거나 그 반대가 된다. 사유를
 * 먼저 정하고 판정은 거기서 파생하면, 늘릴 곳도 어긋날 곳도 하나다.
 */
export function cleanupBlockedReason(
  status: SessionCleanupStatus,
  access: CleanupAccess,
): string | null {
  if (!access.writable) return REMOTE_WRITE_BLOCKED;
  if (!hasAnyCondition(status.policy)) return "정리 조건을 하나 이상 켜야 실행할 수 있습니다.";
  if (access.busy) return "다른 작업이 진행 중입니다.";
  return null;
}

export function canRunCleanup(status: SessionCleanupStatus, access: CleanupAccess): boolean {
  return cleanupBlockedReason(status, access) === null;
}

export function canClearTombstones(status: SessionCleanupStatus, access: CleanupAccess): boolean {
  return status.tombstoneCount > 0 && actionAllowed(access);
}

export function receiptFailed(receipt: SessionCleanupReceipt): boolean {
  return receipt.failedCount > 0;
}
