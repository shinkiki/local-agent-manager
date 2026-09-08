import type { ModelOption, ProviderId, SessionSummary } from "../types";

/**
 * 세션 이력에서 공급자별로 실제 사용한 모델을 모은다. Claude처럼 CLI가 모델 목록을
 * 내보내지 않는 공급자는 이 목록이 유일한 모델 선택지이므로, 새 채팅뿐 아니라 실행 중
 * 채팅·세션 이어가기·시스템 에이전트 실행설정도 같은 목록을 쓴다.
 */
export function collectRecentModels(sessions: SessionSummary[]): ModelOption[] {
  const models = new Map<string, ModelOption>();
  for (const session of sessions) {
    const model = session.model;
    if (!model || session.meta.hidden) continue;
    const key = `${session.source}::${model}`;
    const updatedAt = session.updatedAt ?? 0;
    const known = models.get(key);
    if (known) {
      known.count += 1;
      if (updatedAt > known.updatedAt) known.updatedAt = updatedAt;
      continue;
    }
    models.set(key, { source: session.source, model, count: 1, updatedAt });
  }
  return [...models.values()].sort((left, right) => right.updatedAt - left.updatedAt || right.count - left.count);
}

/** 한 공급자에서 최근 사용한 모델만 최신순으로 돌려준다. */
export function recentModelsFor(sessions: SessionSummary[], source: ProviderId): ModelOption[] {
  return collectRecentModels(sessions).filter((option) => option.source === source);
}
