/**
 * 제안 종류 하나하나가 아는 것 — 지금 스냅샷에서 어떤 후보를 만드는가, 그리고 같은
 * 종류의 두 제안이 어떤 순서로 서는가.
 *
 * 이 둘은 `aiaSuggestionRules.ts`에 규칙 평가의 뼈대(`RuleContext` 선언과 그것을 짓는
 * 자리)와 함께 있었다. 뼈대는 종류를 모르는 것이 요점인데 한 파일에 섞여 있으니
 * 반대가 됐다 — 종류를 하나 더하려고 파일을 열면 파라미터 읽기 규칙과 재무장 메타데이터
 * 배선을 지나쳐 읽어야 했고, 뼈대의 `number`·`duration` 한 줄을 손보려 해도 여덟 벌의
 * 종류별 생성기 사이에서 그 자리를 찾아야 했다. 파일이 자라는 축도 서로 다르다 —
 * 종류는 계속 늘고 뼈대는 거의 그대로다.
 *
 * 그래서 종류가 아는 것만 여기로 옮긴다. 뼈대(`RuleContext`)는 타입으로만 가져오므로
 * 규칙 모듈과의 런타임 순환은 생기지 않는다 — `aiaProjectCleanup.ts`가 이미 같은
 * 방향으로 서 있고, 그 모듈의 생성기와 비교자를 이 표가 그대로 받아 쓴다.
 */
import type { AccountSnapshot, ChatAttentionItem, SchedulerSnapshot } from "../types";
import { DAY, HOUR, MINUTE } from "./aiaPrimitives.ts";
import {
  byNumberMetadataDesc,
  bySuggestionId,
  bySuggestionPriority,
  orderSuggestionsBy,
} from "./aiaSuggestionOrder.ts";
import { compareProjectSuggestions, projectCleanupSuggestions } from "./aiaProjectCleanup.ts";
import { cliMissingProviders, failingTranslations } from "./aiaEvents.ts";
import type { RuleContext } from "./aiaSuggestionRules.ts";
import type { AiaSuggestion, AiaSuggestionKind } from "./aiaSuggestionTypes.ts";

function missingProviderSuggestions(rule: RuleContext) {
  return cliMissingProviders(rule.input.manager, rule.input.automation)
    .map((provider) => rule.suggest(provider.provider, "missing", {
      providerName: provider.displayName || provider.provider,
    }));
}

function accountAuthSuggestions(rule: RuleContext) {
  return (rule.input.accounts?.accounts ?? [])
    .filter((account) => !account.disabled && (account.authStatus === "missing" || account.authStatus === "error"))
    .map((account) => rule.suggest(account.id, account.authStatus, {
      providerName: account.displayName || account.provider,
    }));
}

function autoSwitchSuggestions(rule: RuleContext) {
  const minAccounts = rule.integer("minAccounts", 2, 2, 100);
  const byProvider = new Map<string, NonNullable<AccountSnapshot>["accounts"]>();
  for (const account of rule.input.accounts?.accounts ?? []) {
    if (account.disabled || account.authStatus !== "ready") continue;
    const group = byProvider.get(account.provider) ?? [];
    group.push(account);
    byProvider.set(account.provider, group);
  }
  return [...byProvider.entries()].flatMap(([provider, accounts]) => {
    if (accounts.length < minAccounts || accounts.some((account) => account.autoSwitch)) return [];
    const label = accounts.find((account) => account.isActive)?.displayName || provider;
    return [rule.suggest(provider, `available-${accounts.length}`, { providerName: label })];
  });
}

/**
 * 관측 시각이 붙은 목록에서 "창 안에 든 것만, 최신순으로, 상한만큼" 골라낸다. 반복 요청
 * 실패와 스킬 변경 두 규칙이 이 세 걸음을 각자 펼쳐 놓고 있었다. 동점 처리(같은 시각이면
 * 식별자 사전순)까지 같은 규칙인데 두 벌로 두면 한쪽만 고쳐져, 같은 상황에서 두 제안의
 * 목록이 서로 다른 순서로 잘린다 — 상한에 걸린 목록에서는 정렬이 곧 무엇을 버릴지다.
 *
 * 무엇이 문제인지(어떤 실행을 실패로 볼지, 어떤 변경을 쓸 수 있다고 볼지)는 규칙마다
 * 다르므로 여기서 보지 않는다. 호출부가 걸러 낸 목록을 주고, 이 함수는 시각과 동점
 * 식별자를 읽는 방법만 받는다.
 */
function recentTop<T>(
  rule: RuleContext,
  items: readonly T[],
  options: { within: number; limit: number; at: (item: T) => number; tieKey: (item: T) => string },
): T[] {
  const { within, limit, at, tieKey } = options;
  return items
    .filter((item) => rule.input.now - at(item) <= within)
    .sort((left, right) => at(right) - at(left) || tieKey(left).localeCompare(tieKey(right)))
    .slice(0, limit);
}

function scheduleFailureSuggestions(rule: RuleContext) {
  const scheduler = rule.input.scheduler;
  if (!scheduler) return [];
  const schedules = new Map(scheduler.schedules.map((schedule) => [schedule.id, schedule]));
  const failures = scheduler.runs
    .filter((run) => run.status === "failed" || run.status === "skipped" || Boolean(run.recoveryError));
  return recentTop(rule, failures, {
    within: rule.duration("lookbackHours", 24, 0, 365 * 24, HOUR),
    limit: rule.integer("maxResults", 3, 1, 20),
    at: runTime,
    tieKey: (run) => run.id,
  }).map((run) => {
    const scheduleName = schedules.get(run.scheduleId)?.name ?? run.scheduleId;
    const state = `${run.status}:${run.recoveryError ? "recovery-error" : "no-recovery-error"}`;
    return rule.suggest(run.id, state, { scheduleName });
  });
}

function translationSuggestions(rule: RuleContext) {
  const minFailureCount = rule.integer("minFailureCount", 1, 1, 10_000);
  return failingTranslations(rule.input.automation, minFailureCount)
    .map((translation) => rule.suggest(translation.target, translation.stateKey, {
      translationTarget: translation.target,
    }));
}

function interruptedSuggestions(rule: RuleContext) {
  const delay = rule.duration("delayMinutes", 30, 0, 365 * 24 * 60, MINUTE);
  const expiry = rule.duration("expiresDays", 7, 0, 3650, DAY);
  return rule.input.attention.items.flatMap((item) => {
    if (!isInterruptedCandidate(item)) return [];
    const age = rule.input.now - item.createdAt;
    if (age < delay || age > expiry || hasNewerResume(rule.input.attention.items, item)) return [];
    return [rule.suggest(item.id, `${item.chatId}:${item.providerSessionId ?? "none"}:${item.createdAt}`, {
      sessionTitle: item.title,
      providerName: item.source,
    })];
  });
}

/**
 * 즉시 트리거. 스킬 내용 변경이 감지된 직후 검토 제안을 만든다. 임계값이나 지연
 * 없이 감지된 변경을 그대로 쓰고, `expiresHours`가 지난 변경만 스스로 내린다.
 */
function skillChangeSuggestions(rule: RuleContext) {
  const usable = (rule.input.skillChanges ?? []).filter((change) => change.key && change.digest);
  return recentTop(rule, usable, {
    within: rule.duration("expiresHours", 24, 1, 720, HOUR),
    limit: rule.integer("maxResults", 3, 1, 10),
    at: (change) => change.detectedAt,
    tieKey: (change) => change.key,
  }).map((change) => rule.suggest(change.key, `${change.previousDigest}:${change.digest}`, {
    skillName: change.name || change.key,
    detectedAt: change.detectedAt,
  }));
}

function isInterruptedCandidate(item: ChatAttentionItem): boolean {
  return item.profile === "standard"
    && !item.unattended
    && item.kind === "failed"
    && item.detail?.trim().toLowerCase() === "interrupted";
}

function hasNewerResume(items: ChatAttentionItem[], interrupted: ChatAttentionItem): boolean {
  return items.some((item) => {
    if (item.createdAt <= interrupted.createdAt || (item.kind !== "running" && item.kind !== "completed")) return false;
    if (item.chatId === interrupted.chatId) return true;
    return interrupted.providerSessionId !== null && item.providerSessionId === interrupted.providerSessionId;
  });
}

function runTime(run: SchedulerSnapshot["runs"][number]): number {
  return run.finishedAt ?? run.startedAt ?? run.scheduledFor;
}

/** 종류와 무관한 뼈대 — 우선순위가 높은 것부터, 같으면 id 사전순. */
const compareByPriority = orderSuggestionsBy(bySuggestionPriority, bySuggestionId);

/** 같은 우선순위의 스킬 변경 제안은 방금 감지된 것을 먼저 보여준다. */
const compareSkillChangeSuggestions = orderSuggestionsBy(
  bySuggestionPriority,
  byNumberMetadataDesc("detectedAt"),
  bySuggestionId,
);

/**
 * 종류 하나가 아는 것 — 지금 스냅샷에서 어떤 후보를 만드는가(`suggest`), 그리고 같은
 * 종류의 두 제안이 어떤 순서로 서는가(`compare`).
 *
 * 두 값이 종류를 키로 삼는 표 두 벌로 나뉘어 있었다. 정렬 예외를 적는 자리가 그 종류의
 * 생성기에서 멀리 떨어져 있어, 새 종류를 더하면서 정렬 쪽 한 줄을 빠뜨려도 형식 오류가
 * 나지 않는다 — 우선순위가 같은 제안들이 id 사전순으로 조용히 서게 될 뿐이다. 종류가
 * 자기 두 가지를 한 줄로 갖게 둔다.
 */
interface KindRules {
  /**
   * 이 종류가 지금 만드는 후보. 종류별 부산물(프로젝트 정리의 임계 상태)은 반환값이
   * 아니라 `rule.projectState`로 문맥에 쌓인다 — 부산물을 가진 종류가 하나뿐인데
   * 반환 모양을 열한 종류가 함께 지고 있을 이유가 없다.
   */
  suggest(rule: RuleContext): AiaSuggestion[];
  /**
   * 같은 종류의 두 제안을 견주는 비교자. 뼈대(`compareByPriority`)를 대신하므로
   * 우선순위까지 스스로 본다. 없으면 뼈대가 그대로 선다.
   */
  compare?: (left: AiaSuggestion, right: AiaSuggestion) => number;
}

const KIND_RULES: Record<AiaSuggestionKind, KindRules> = {
  providerCliMissing: { suggest: missingProviderSuggestions },
  accountAuthError: { suggest: accountAuthSuggestions },
  // 사용량은 사이드바 계량기로 이미 보이므로 선제 제안에서 제외한다.
  accountUsageThreshold: { suggest: () => [] },
  accountAutoSwitchMissing: { suggest: autoSwitchSuggestions },
  schedulerPaused: {
    suggest: (rule) => (rule.input.scheduler?.paused ? [rule.suggest("scheduler", "paused", {})] : []),
  },
  scheduleRunFailed: { suggest: scheduleFailureSuggestions },
  translationFailed: { suggest: translationSuggestions },
  projectSessionCleanup: { suggest: projectCleanupSuggestions, compare: compareProjectSuggestions },
  interruptedSessionReminder: { suggest: interruptedSuggestions },
  skillContentChanged: { suggest: skillChangeSuggestions, compare: compareSkillChangeSuggestions },
  featureTip: {
    suggest: (rule) => [rule.suggest(rule.definitionId, "one-time", {
      featureName: rule.string("featureName", rule.string("featureId", rule.definitionId)),
    })],
  },
};

/** 이 종류가 지금 스냅샷에서 만드는 후보. */
export function suggestionsOfKind(kind: AiaSuggestionKind, rule: RuleContext): AiaSuggestion[] {
  return KIND_RULES[kind].suggest(rule);
}

/** 종류가 서로 다른 두 제안은 종류별 정렬을 쓸 수 없으므로 뼈대만 지난다. */
export function compareSuggestions(left: AiaSuggestion, right: AiaSuggestion): number {
  const sameKind = left.kind === right.kind ? KIND_RULES[left.kind].compare : undefined;
  return sameKind ? sameKind(left, right) : compareByPriority(left, right);
}
