/**
 * 관리 스냅숏 변경분을 화면이 들고 있는 스냅숏에 합친다.
 *
 * 조정 한 회차에서 실제로 달라지는 세션은 대개 한두 건인데, 예전에는 개정 번호가 오를 때마다
 * 세션 2,500건(3.1MB)을 통째로 다시 받아 통째로 새 객체로 만들었다. 그러면 목록의 모든 행이
 * 참조가 달라져 memo가 전부 무효가 되고, 바뀌지 않은 행까지 다시 그렸다.
 *
 * 여기서는 바뀌지 않은 세션의 **객체 참조를 그대로 물려준다.** 한 건도 바뀌지 않은 회차는
 * 배열 자체도 물려주므로 `sessions`를 의존성으로 쓰는 useMemo까지 그대로 살아남는다.
 */
import type { ManagerSnapshot, ManagerSnapshotSync, SessionRef, SessionSummary } from "../types";
import { sessionKey } from "./sessionKey.ts";

/** 목록 중복 제거·정리폴더 집계와 같은 키 형식을 쓴다. */
function keyOf(ref: SessionRef | SessionSummary): string {
  return sessionKey(ref.source, ref.id);
}

/**
 * 백엔드(`compose_manager_snapshot`)와 같은 순서 — updatedAt 내림차순, 값이 없는 세션은 뒤.
 * JS의 sort는 안정 정렬이라 같은 시각끼리는 직전 순서를 유지한다. 백엔드도 안정 정렬이므로
 * 전체를 다시 받았을 때와 같은 목록이 된다.
 */
function byUpdatedAtDesc(left: SessionSummary, right: SessionSummary): number {
  if (left.updatedAt === right.updatedAt) return 0;
  if (left.updatedAt === null || left.updatedAt === undefined) return 1;
  if (right.updatedAt === null || right.updatedAt === undefined) return -1;
  return right.updatedAt - left.updatedAt;
}

interface SessionDeltaIndex {
  removed: Set<string>;
  patched: Map<string, SessionSummary>;
}

/**
 * 삭제와 교체를 같은 세션 키로 찾을 수 있게 한 번만 색인한다. 목록 순회는 이 색인이
 * 어떻게 만들어졌는지 알 필요 없이 기존 항목을 유지·삭제·교체하는 순서에만 집중한다.
 */
function indexSessionDelta(
  changedSessions: SessionSummary[],
  removedSessions: SessionRef[],
): SessionDeltaIndex {
  return {
    removed: new Set(removedSessions.map(keyOf)),
    patched: new Map(changedSessions.map((session) => [keyOf(session), session])),
  };
}

/**
 * 세션 변경분만 직전 목록에 적용한다. 스냅숏의 나머지 필드를 새 봉투로 옮기는 일과
 * 목록의 참조 보존·삭제·교체·정렬 규칙을 갈라, 어느 쪽을 고쳐도 다른 쪽의 구조를
 * 다시 읽지 않게 한다.
 */
function mergeSessionDelta(
  base: SessionSummary[],
  changedSessions: SessionSummary[],
  removedSessions: SessionRef[],
): SessionSummary[] {
  if (changedSessions.length === 0 && removedSessions.length === 0) return base;

  const { removed, patched } = indexSessionDelta(changedSessions, removedSessions);
  const sessions: SessionSummary[] = [];
  for (const session of base) {
    const key = keyOf(session);
    if (removed.has(key)) continue;
    const replacement = patched.get(key);
    if (replacement) {
      patched.delete(key);
      sessions.push(replacement);
      continue;
    }
    sessions.push(session);
  }
  for (const added of patched.values()) sessions.push(added);
  sessions.sort(byUpdatedAtDesc);
  return sessions;
}

export function mergeManagerSnapshot(
  previous: ManagerSnapshot | null,
  sync: ManagerSnapshotSync,
): ManagerSnapshot {
  if (sync.kind === "full") {
    const { kind: _kind, ...snapshot } = sync;
    return snapshot;
  }
  const { kind: _kind, changedSessions, removedSessions, ...rest } = sync;
  // 델타는 화면이 이미 목록을 들고 있을 때만 요청한다. 그래도 비어 있는 상태로 들어오면
  // 바뀐 것만 있는 목록으로 두고, 다음 회차가 전체를 받아 복구한다.
  const base = previous?.sessions ?? [];
  return { ...rest, sessions: mergeSessionDelta(base, changedSessions, removedSessions) };
}
