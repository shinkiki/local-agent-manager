/**
 * 세션 자동정리 시험 두 벌이 함께 쓰는 재료 — 조건 정책, 카드가 받는 상태, 미리보기,
 * 영수증.
 *
 * 판정(`sessionCleanup.ts`)과 문구(`sessionCleanupText.ts`)를 두 모듈로 가르면서 시험도
 * 함께 갈렸는데, 재료는 갈리지 않고 두 파일에 같은 리터럴로 복제됐다. 영수증 열두 줄은
 * 글자 하나까지 같았고 미리보기 여덟 줄은 한쪽에서 상태 안에 박혀 있어 같은 모양인 줄도
 * 나란히 놓고서야 알 수 있었다. 이 모양들은 `types.ts`를 따라 움직이므로 필드가 하나 늘면
 * 한 벌만 고쳐지기 쉽고, 그러면 다른 파일의 시험만 조용히 옛 모양으로 통과한다.
 *
 * `.test.mjs`가 아니므로 시험 실행기(`src/lib/*.test.mjs`)가 이 파일을 직접 돌리지
 * 않는다. 시험이 아니라 시험의 재료다.
 */

/**
 * 정리할 대상을 만드는 조건을 모두 끈 정책 조각. 조건이 하나도 없을 때를 보는 시험이
 * 다섯 줄을 각자 적고 있었는데, 그 다섯이 곧 `CLEANUP_CONDITION_KEYS`라 조건이 하나 늘면
 * 적어 둔 쪽만 옛 목록으로 남는다.
 */
export const NO_CLEANUP_CONDITIONS = {
  retentionDays: null,
  maxMessageCount: null,
  perProviderCap: null,
  perAutomationCap: null,
  hiddenAfterDays: null,
};

export function cleanupPolicy(overrides = {}) {
  return {
    enabled: true,
    retentionDays: 90,
    maxMessageCount: 1,
    perProviderCap: 400,
    perAutomationCap: 30,
    hiddenAfterDays: 7,
    trashRetentionDays: 14,
    intervalHours: 24,
    ...overrides,
  };
}

export function cleanupPreview(overrides = {}) {
  return {
    targetCount: 0,
    removableCount: 0,
    removableBytes: 0,
    protectedCount: 0,
    remainingCount: 0,
    byReason: [],
    orphanAttachmentCount: 0,
    orphanAttachmentBytes: 0,
    ...overrides,
  };
}

export function cleanupReceipt(overrides = {}) {
  return {
    startedAt: 0,
    finishedAt: 0,
    manual: false,
    tombstonedCount: 0,
    removedCount: 0,
    skippedCount: 0,
    skippedReasons: [],
    failedCount: 0,
    bytesFreed: 0,
    trashPurgedCount: 0,
    entriesTruncated: false,
    entries: [],
    ...overrides,
  };
}

export function cleanupStatus(overrides = {}) {
  return {
    policy: cleanupPolicy(),
    lastRunAt: null,
    nextRunAt: null,
    sessionCount: 2866,
    tombstoneCount: 0,
    preview: cleanupPreview(),
    receipts: [],
    ...overrides,
  };
}
