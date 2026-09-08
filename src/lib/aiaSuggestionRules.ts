/**
 * 제안 규칙 평가와 정렬. `aiaSuggestions.ts`가 카탈로그 순회와 이력 반영을 맡는 동안
 * 여기서는 "정의 하나가 지금 스냅샷에서 어떤 후보를 만드는가"와 "만들어진 후보를 어떤
 * 순서로 보여주는가"만 다룬다. 종류가 늘 때마다 한 파일이 함께 자라던 것을 갈랐다.
 *
 * 종류 하나에만 필요한 집계와 정렬은 그 종류의 모듈이 갖는다(프로젝트 정리는
 * `aiaProjectCleanup.ts`). 여기 남는 것은 종류와 무관한 뼈대뿐이다.
 *
 * 타입 선언은 그대로 `aiaSuggestions.ts`에 두고 여기서는 타입만 가져다 쓴다(런타임
 * 순환이 생기지 않는다).
 */
import type { AccountSnapshot, ChatAttentionItem, SchedulerSnapshot } from "../types";
import { clampedInteger, clampedNumber, DAY, finiteNumber, HOUR, MINUTE } from "./aiaPrimitives.ts";
import { compareProjectSuggestions, projectCleanupSuggestions } from "./aiaProjectCleanup.ts";
import { providerStatuses, translationEntries, translationFailureCount } from "./aiaEvents.ts";
import type { ProjectDismissalState } from "./aiaSuggestionHistory.ts";
import { numberMetadata, suggestionFingerprint } from "./aiaSuggestionHistory.ts";
import type {
  AiaSuggestion,
  AiaSuggestionDefinition,
  AiaSuggestionEvaluationInput,
  AiaSuggestionPack,
} from "./aiaSuggestions.ts";

const TEMPLATE_FIELDS = new Set([
  "projectName",
  "projectPath",
  "sessionTitle",
  "providerName",
  "usagePercent",
  "scheduleName",
  "featureName",
  "translationTarget",
  "skillName",
]);

export function evaluateDefinition(
  pack: AiaSuggestionPack,
  definition: AiaSuggestionDefinition,
  input: AiaSuggestionEvaluationInput,
): { suggestions: AiaSuggestion[]; projectStates: ProjectDismissalState[] } {
  const rule = ruleContext(pack, definition, input);
  switch (definition.kind) {
    case "providerCliMissing":
      return result(missingProviderSuggestions(rule));
    case "accountAuthError":
      return result(accountAuthSuggestions(rule));
    case "accountUsageThreshold":
      // 사용량은 사이드바 계량기로 이미 보이므로 선제 제안에서 제외한다.
      return result([]);
    case "accountAutoSwitchMissing":
      return result(autoSwitchSuggestions(rule));
    case "schedulerPaused":
      return result(input.scheduler?.paused ? [rule.suggest("scheduler", "paused", {})] : []);
    case "scheduleRunFailed":
      return result(scheduleFailureSuggestions(rule));
    case "translationFailed":
      return result(translationSuggestions(rule));
    case "projectSessionCleanup":
      return projectCleanupSuggestions(rule);
    case "interruptedSessionReminder":
      return result(interruptedSuggestions(rule));
    case "skillContentChanged":
      return result(skillChangeSuggestions(rule));
    case "featureTip":
      return result([rule.suggest(definition.id, "one-time", {
        featureName: rule.string("featureName", rule.string("featureId", definition.id)),
      })]);
  }
}

/**
 * 규칙 하나를 평가하는 동안 바뀌지 않는 것(어느 팩의 어느 정의를, 어느 스냅샷에서)을
 * 묶어 둔다. 종류별 생성기가 저마다 `pack`·`definition`·`input` 세 인자를 받아 그대로
 * 다시 넘기던 것을 없애고, 정의 파라미터를 읽는 자리도 키와 기본값만 남긴다.
 */
export interface RuleContext {
  /** 정의 식별자. 제안 id·숨김 키를 만드는 데만 쓴다. */
  definitionId: string;
  input: AiaSuggestionEvaluationInput;
  packId: string;
  /** 이 정의가 만드는 제안 하나. 대상과 상태 키, 템플릿·메타데이터 필드만 넘긴다. */
  suggest(targetId: string, stateKey: string, fields: Record<string, string | number | boolean | null>): AiaSuggestion;
  /** 정의가 준 실수 파라미터를 범위로 자른 값. 숫자가 아니면 기본값. */
  number(key: string, fallback: number, minimum: number, maximum: number): number;
  /** 개수·상한처럼 정수여야 하는 파라미터. */
  integer(key: string, fallback: number, minimum: number, maximum: number): number;
  /** 재무장 설정(`rearm`)이 준 정수 파라미터. 파라미터와 읽는 규칙이 같다. */
  rearmInteger(key: string, fallback: number, minimum: number, maximum: number): number;
  /** `unit` 단위로 준 기간 파라미터를 밀리초로 읽는다. */
  duration(key: string, fallback: number, minimum: number, maximum: number, unit: number): number;
  /** 문자열 파라미터. 문자열이 아니면 기본값. */
  string(key: string, fallback: string): string;
}

function ruleContext(
  pack: AiaSuggestionPack,
  definition: AiaSuggestionDefinition,
  input: AiaSuggestionEvaluationInput,
): RuleContext {
  const number = (key: string, fallback: number, minimum: number, maximum: number) =>
    clampedNumber(definition.parameters, key, fallback, minimum, maximum);
  return {
    definitionId: definition.id,
    input,
    packId: pack.packId,
    suggest: (targetId, stateKey, fields) => makeSuggestion(pack, definition, targetId, stateKey, fields),
    number,
    integer: (key, fallback, minimum, maximum) => clampedInteger(definition.parameters, key, fallback, minimum, maximum),
    rearmInteger: (key, fallback, minimum, maximum) => clampedInteger(definition.rearm, key, fallback, minimum, maximum),
    duration: (key, fallback, minimum, maximum, unit) => number(key, fallback, minimum, maximum) * unit,
    string: (key, fallback) => {
      const value = definition.parameters?.[key];
      return typeof value === "string" ? value : fallback;
    },
  };
}

function result(suggestions: AiaSuggestion[]) {
  return { suggestions, projectStates: [] as ProjectDismissalState[] };
}

function missingProviderSuggestions(rule: RuleContext) {
  return providerStatuses(rule.input.manager, rule.input.automation)
    .filter((provider) => !provider.cli.detected)
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

function scheduleFailureSuggestions(rule: RuleContext) {
  const scheduler = rule.input.scheduler;
  if (!scheduler) return [];
  const schedules = new Map(scheduler.schedules.map((schedule) => [schedule.id, schedule]));
  const maxResults = rule.integer("maxResults", 3, 1, 20);
  const lookback = rule.duration("lookbackHours", 24, 0, 365 * 24, HOUR);
  return scheduler.runs
    .filter((run) => (run.status === "failed" || run.status === "skipped" || Boolean(run.recoveryError))
      && rule.input.now - runTime(run) <= lookback)
    .sort((left, right) => runTime(right) - runTime(left) || left.id.localeCompare(right.id))
    .slice(0, maxResults)
    .map((run) => {
      const scheduleName = schedules.get(run.scheduleId)?.name ?? run.scheduleId;
      const state = `${run.status}:${run.recoveryError ? "recovery-error" : "no-recovery-error"}`;
      return rule.suggest(run.id, state, { scheduleName });
    });
}

function translationSuggestions(rule: RuleContext) {
  const minFailureCount = rule.integer("minFailureCount", 1, 1, 10_000);
  return translationEntries(rule.input.automation).flatMap(([target, status]) => {
    const failed = translationFailureCount(status);
    if (status.phase !== "error" && failed < minFailureCount) return [];
    return [rule.suggest(target, `${status.phase}:${failed}`, { translationTarget: target })];
  });
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
  const expiry = rule.duration("expiresHours", 24, 1, 720, HOUR);
  const maxResults = rule.integer("maxResults", 3, 1, 10);
  return (rule.input.skillChanges ?? [])
    .filter((change) => change.key && change.digest && rule.input.now - change.detectedAt <= expiry)
    .sort((left, right) => right.detectedAt - left.detectedAt || left.key.localeCompare(right.key))
    .slice(0, maxResults)
    .map((change) => rule.suggest(change.key, `${change.previousDigest}:${change.digest}`, {
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

function makeSuggestion(
  pack: AiaSuggestionPack,
  definition: AiaSuggestionDefinition,
  targetId: string,
  stateKey: string,
  fields: Record<string, string | number | boolean | null>,
): AiaSuggestion {
  const metadata = {
    ...fields,
    cooldownMinutes: finiteNumber(definition.rearm?.cooldownMinutes) ?? 0,
    afterResolved: definition.rearm?.afterResolved === true,
  };
  const templateFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => TEMPLATE_FIELDS.has(key)),
  ) as Record<string, string | number | boolean | null>;
  const fingerprint = suggestionFingerprint(pack.packId, definition.id, targetId, stateKey);
  return {
    id: `${pack.packId}:${definition.id}:${targetId}`,
    definitionId: definition.id,
    fingerprint,
    kind: definition.kind,
    severity: definition.severity,
    priority: definition.priority,
    title: boundedTemplate(definition.titleTemplate, templateFields, 80),
    detail: boundedTemplate(definition.detailTemplate, templateFields, 240),
    prompt: boundedTemplate(definition.promptTemplate, templateFields, 1000),
    packId: pack.packId,
    packDisplayName: pack.displayName,
    source: pack.source ?? "bundled",
    skillKey: pack.skillKey ?? null,
    targetId,
    stateKey,
    metadata,
  };
}

function renderAiaSuggestionTemplate(
  template: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): string | null {
  let valid = true;
  const rendered = template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    if (!TEMPLATE_FIELDS.has(name)) {
      valid = false;
      return "";
    }
    const value = fields[name];
    return value === null || value === undefined ? "" : String(value);
  });
  return valid ? rendered : null;
}

function boundedTemplate(template: string, fields: Record<string, string | number | boolean | null>, limit: number): string {
  const rendered = renderAiaSuggestionTemplate(template, fields) ?? "";
  if (rendered.length <= limit) return rendered;
  return `${rendered.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function compareSuggestions(left: AiaSuggestion, right: AiaSuggestion): number {
  if (left.kind === "projectSessionCleanup" && right.kind === "projectSessionCleanup") {
    return compareProjectSuggestions(left, right);
  }
  // 같은 우선순위의 스킬 변경 제안은 방금 감지된 것을 먼저 보여준다.
  if (left.kind === "skillContentChanged" && right.kind === "skillContentChanged" && left.priority === right.priority) {
    return numberMetadata(right, "detectedAt", 0) - numberMetadata(left, "detectedAt", 0) || left.id.localeCompare(right.id);
  }
  const priority = right.priority - left.priority;
  if (priority !== 0) return priority;
  return left.id.localeCompare(right.id);
}

function runTime(run: SchedulerSnapshot["runs"][number]): number {
  return run.finishedAt ?? run.startedAt ?? run.scheduledFor;
}

