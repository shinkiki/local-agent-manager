/**
 * 백엔드가 돌려준 매니저 스냅샷의 빠진 필드를 화면이 쓸 수 있는 값으로 채운다.
 *
 * 이 일은 백엔드 명령을 부르는 일이 아니라 받은 값의 모양을 확정하는 일인데,
 * `ipc.ts`의 명령 한 줄짜리 목록 한가운데에 두 덩이로 흩어져 있었다(스냅샷 조립은
 * 저장소 개요와 예산 조회 사이에, 필드별 기본값은 번역 명령과 채팅 명령 사이에).
 * 명령 목록을 훑는 사람에게는 잡음이고, 기본값을 고치려면 그 목록을 뒤져야 했다.
 *
 * 이름도 함께 바로잡는다. 예전 이름 `normalizeManagerSnapshot`은 `sessionCatalog.ts`가
 * 내보내는 **다른 일을 하는 같은 이름** 함수와 겹쳤다(그쪽은 중복 세션 제거다).
 * 실제로 `App.tsx`는 둘을 잇달아 부르므로, 같은 이름이 서로 다른 단계를 가리키면
 * 어느 쪽이 무엇을 했는지 읽을 수 없다. 여기서는 하는 일 그대로 "기본값을 채운다"로 적는다.
 *
 * 스냅샷을 **읽어 오는** 명령은 여기 두지 않는다(`ipcWorkspace`에 있다). 이 파일은 받은
 * 값의 모양만 다루므로 전송 모듈을 들이지 않고, 그래서 `ipcSnapshot.test.mjs`가 브라우저
 * 셸 없이 이 파일 하나만 불러 돌 수 있다.
 */
import type { ManagerSnapshot, ManagerSnapshotSync, SessionMeta, SessionSummary, SourceCounts, SourceTotals } from "../types";

/** 세션 메타의 빠진 필드를 기본값으로 채운다. 옛 저장본에는 없는 필드가 있다. */
export function sessionMetaWithDefaults(meta: Partial<SessionMeta> | null | undefined): SessionMeta {
  return {
    favorite: Boolean(meta?.favorite),
    hidden: Boolean(meta?.hidden),
    note: meta?.note ?? null,
    customTitle: meta?.customTitle ?? null,
    folderIds: Array.isArray(meta?.folderIds) ? meta.folderIds : [],
    reasoningEffort: meta?.reasoningEffort ?? null,
    mode: meta?.mode ?? null,
    approvalMode: meta?.approvalMode ?? null,
    creationAccountId: meta?.creationAccountId ?? null,
    boundAccountId: meta?.boundAccountId ?? null,
    pinnedAccountId: meta?.pinnedAccountId ?? null,
    // 아래 셋은 기본값이 필요 없는 선택 필드지만, 이 함수가 메타를 필드별로 다시 지으므로
    // 여기 적지 않으면 백엔드가 보낸 값이 화면에 닿기 전에 사라진다. 실제로 세션 목록의
    // 반복 요청 필터(출처)와 인계 기록 구역이 통째로 죽어 있었다.
    origin: meta?.origin ?? null,
    handoffOrigin: meta?.handoffOrigin ?? null,
    handoffTargets: meta?.handoffTargets ?? [],
  };
}

/** 공급자별 집계. 빠진 공급자는 0으로 둔다 — 화면이 칸을 언제나 다 그리기 때문이다. */
export function sourceCountsWithDefaults(counts: Partial<SourceCounts> | null | undefined): SourceCounts {
  return {
    claude: counts?.claude ?? 0,
    codex: counts?.codex ?? 0,
    antigravity: counts?.antigravity ?? 0,
    local: counts?.local ?? 0,
  };
}

export function sourceTotalsWithDefaults(totals: Partial<SourceTotals> | null | undefined): SourceTotals {
  return {
    ...sourceCountsWithDefaults(totals),
    total: totals?.total ?? 0,
  };
}

/** 세션 하나의 메타 기본값. 전체 스냅샷과 변경분이 같은 규칙을 쓴다. */
function sessionWithDefaults(session: SessionSummary): SessionSummary {
  return { ...session, meta: sessionMetaWithDefaults(session.meta) };
}

/** 대시보드 집계의 기본값. 전체 스냅샷과 변경분이 같은 규칙을 쓴다. */
function dashboardWithDefaults(dashboard: ManagerSnapshot["dashboard"]): ManagerSnapshot["dashboard"] {
  return {
    ...dashboard,
    sessionsBySource: sourceCountsWithDefaults(dashboard.sessionsBySource),
    tokens: sourceTotalsWithDefaults(dashboard.tokens),
    disk: sourceTotalsWithDefaults(dashboard.disk),
    weekly: dashboard.weekly.map((week) => ({ ...week, ...sourceCountsWithDefaults(week) })),
    recent: dashboard.recent.map(sessionWithDefaults),
  };
}

interface CommonSnapshotTarget {
  sessionCatalogRevision?: number;
  resourceCatalogRevision?: number;
  folders?: ManagerSnapshot["folders"];
  dashboard: ManagerSnapshot["dashboard"];
}

/** 전체 스냅샷과 증분 동기화가 공통으로 들고 오는 카탈로그 리비전·폴더·대시보드 기본값. */
function commonSnapshotFieldsWithDefaults(target: CommonSnapshotTarget) {
  return {
    sessionCatalogRevision: target.sessionCatalogRevision ?? 0,
    resourceCatalogRevision: target.resourceCatalogRevision ?? 0,
    folders: target.folders ?? [],
    dashboard: dashboardWithDefaults(target.dashboard),
  };
}

/** 스냅샷 전체에 기본값을 채운다. 세션 목록과 대시보드 최근 목록은 같은 규칙을 쓴다. */
export function managerSnapshotWithDefaults(snapshot: ManagerSnapshot): ManagerSnapshot {
  return {
    ...snapshot,
    ...commonSnapshotFieldsWithDefaults(snapshot),
    sessions: snapshot.sessions.map(sessionWithDefaults),
  };
}

/**
 * 변경분 응답에 기본값을 채운다. 같은 호출이 전체 스냅샷을 돌려줄 수도 있으므로 두 모양을
 * 여기서 함께 다룬다 — 호출부가 종류를 가려 서로 다른 정규화를 부르면 한쪽만 고쳐질 자리다.
 */
export function managerSnapshotSyncWithDefaults(sync: ManagerSnapshotSync): ManagerSnapshotSync {
  if (sync.kind === "full") return { ...managerSnapshotWithDefaults(sync), kind: "full" };
  return {
    ...sync,
    ...commonSnapshotFieldsWithDefaults(sync),
    changedSessions: (sync.changedSessions ?? []).map(sessionWithDefaults),
    removedSessions: sync.removedSessions ?? [],
  };
}
