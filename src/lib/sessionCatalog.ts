import type { ManagerSnapshot, SessionSummary } from "../types";
import { sessionKey } from "./sessionKey.ts";

/**
 * 같은 공급자의 같은 세션 ID는 하나의 논리 세션이므로 목록에 한 번만 남긴다.
 * 백엔드가 이미 중복을 제거하지만, 목록 항목 키가 `source:id`라서 중복이 새어 나오면
 * React 재조정이 어긋나 낡은 행이 남는다. 화면 경계에서도 같은 규칙으로 한 번 더 막는다.
 */
export function dedupeSessionSummaries(sessions: SessionSummary[]): SessionSummary[] {
  const positions = new Map<string, number>();
  const deduped: SessionSummary[] = [];
  for (const session of sessions) {
    const key = sessionKey(session.source, session.id);
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, deduped.length);
      deduped.push(session);
    } else if (prefersSession(session, deduped[index])) {
      deduped[index] = session;
    }
  }
  return deduped;
}

/** 최근 갱신 → 더 많은 메시지 → 더 큰 파일 순으로 남길 항목을 고르고, 모두 같으면 경로로 고정한다. */
function prefersSession(candidate: SessionSummary, current: SessionSummary): boolean {
  const left = sessionCompleteness(candidate);
  const right = sessionCompleteness(current);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return candidate.filePath < current.filePath;
}

function sessionCompleteness(session: SessionSummary): number[] {
  return [
    session.updatedAt ?? Number.NEGATIVE_INFINITY,
    session.messageCount ?? 0,
    session.sizeBytes ?? 0,
  ];
}

/** 스냅샷의 세션 목록과 대시보드 최근 목록을 같은 규칙으로 정리한다. */
export function normalizeManagerSnapshot(snapshot: ManagerSnapshot): ManagerSnapshot {
  const sessions = dedupeSessionSummaries(snapshot.sessions);
  const recent = dedupeSessionSummaries(snapshot.dashboard.recent);
  if (sessions.length === snapshot.sessions.length && recent.length === snapshot.dashboard.recent.length) {
    return snapshot;
  }
  return { ...snapshot, sessions, dashboard: { ...snapshot.dashboard, recent } };
}
