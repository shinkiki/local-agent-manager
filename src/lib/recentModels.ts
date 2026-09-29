import type { ModelOption, ProviderId, SessionSummary } from "../types";
import { bucketFor, compareRankDesc } from "./sequence.ts";

/**
 * 세션 이력에서 실제 사용한 모델을 모은다. 공급자 필터가 주어지면 해당 공급자의
 * 세션만 걸러 집계하므로 불필요한 전체 집계와 정렬을 피한다.
 */
function aggregateRecentModels(
  sessions: SessionSummary[],
  sourceFilter?: ProviderId,
): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const session of sessions) {
    if (sourceFilter && session.source !== sourceFilter) continue;
    const model = session.model;
    if (!model || session.meta.hidden) continue;
    const key = `${session.source}::${model}`;
    const updatedAt = session.updatedAt ?? 0;
    const known = bucketFor(models, key, () => (
      { source: session.source, model, count: 0, updatedAt: 0 }
    ));
    known.count += 1;
    if (updatedAt > known.updatedAt) known.updatedAt = updatedAt;
  }
  return [...models.values()]
    .sort((left, right) => compareRankDesc([left.updatedAt, left.count], [right.updatedAt, right.count]));
}

/**
 * 세션 이력에서 공급자별로 실제 사용한 모델을 모은다. Claude처럼 CLI가 모델 목록을
 * 내보내지 않는 공급자는 이 목록이 유일한 모델 선택지이므로, 새 채팅뿐 아니라 실행 중
 * 채팅·세션 이어가기·시스템 에이전트 실행설정도 같은 목록을 쓴다.
 */
export function collectRecentModels(sessions: SessionSummary[]): ModelOption[] {
  return aggregateRecentModels(sessions);
}

/** 한 공급자에서 최근 사용한 모델만 최신순으로 돌려준다. */
export function recentModelsFor(sessions: SessionSummary[], source: ProviderId): ModelOption[] {
  return aggregateRecentModels(sessions, source);
}

