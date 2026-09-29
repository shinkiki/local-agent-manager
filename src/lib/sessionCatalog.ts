import type { ManagerSnapshot, SessionSummary } from "../types";
import { compareRankDesc, dedupeByKey } from "./sequence.ts";
import { sessionKey } from "./sessionKey.ts";

/**
 * 같은 공급자의 같은 세션 ID는 하나의 논리 세션이므로 목록에 한 번만 남긴다.
 * 백엔드가 이미 중복을 제거하지만, 목록 항목 키가 `source:id`라서 중복이 새어 나오면
 * React 재조정이 어긋나 낡은 행이 남는다. 화면 경계에서도 같은 규칙으로 한 번 더 막는다.
 *
 * 겹칠 때 무엇을 남기는지만 여기서 정한다 — 열쇠로 모으고 최초 자리를 지키는 일은
 * [`dedupeByKey`]가 맡는다.
 */
export function dedupeSessionSummaries(sessions: SessionSummary[]): SessionSummary[] {
  return dedupeByKey(sessions, (session) => sessionKey(session.source, session.id), prefersSession);
}

/** 최근 갱신 → 더 많은 메시지 → 더 큰 파일 순으로 남길 항목을 고르고, 모두 같으면 경로로 고정한다. */
function prefersSession(candidate: SessionSummary, current: SessionSummary): boolean {
  const order = compareRankDesc(sessionCompleteness(candidate), sessionCompleteness(current));
  return order === 0 ? candidate.filePath < current.filePath : order < 0;
}

function sessionCompleteness(session: SessionSummary): number[] {
  return [
    session.updatedAt ?? Number.NEGATIVE_INFINITY,
    session.messageCount ?? 0,
    session.sizeBytes ?? 0,
  ];
}

/**
 * 스냅샷의 세션 목록과 대시보드 최근 목록에서 중복 항목을 같은 규칙으로 걷어낸다.
 * 걷어낼 것이 없으면 받은 스냅샷을 그대로 돌려주므로 참조가 유지된다.
 *
 * `ipc.ts`에도 같은 이름의 기본값 채우기가 따로 있었는데, 이름이 같아 한쪽을 다른 쪽의
 * 중복 호출로 오해하기 쉬웠다. 이쪽은 중복 제거만 한다는 뜻을 이름에 남긴다.
 */
export function dedupeManagerSnapshot(snapshot: ManagerSnapshot): ManagerSnapshot {
  const sessions = dedupeSessionSummaries(snapshot.sessions);
  const recent = dedupeSessionSummaries(snapshot.dashboard.recent);
  if (sessions.length === snapshot.sessions.length && recent.length === snapshot.dashboard.recent.length) {
    return snapshot;
  }
  return { ...snapshot, sessions, dashboard: { ...snapshot.dashboard, recent } };
}
