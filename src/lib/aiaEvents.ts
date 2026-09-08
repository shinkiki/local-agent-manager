/**
 * AIA 사건 감지와 발송 예산. 제안 평가(`aiaSuggestions.ts`)와 같은 스냅샷을 읽지만
 * 하는 일이 다르다 — 제안은 "지금 상태가 규칙에 걸리는가"를 보고, 사건은 "직전 판과
 * 견주어 무엇이 새로 나빠졌는가"를 본다. 한 파일에 섞여 있어 제안 규칙을 고칠 때
 * 사건 기준선까지 함께 읽어야 했으므로 여기로 떼어냈다.
 *
 * 두 쪽이 함께 쓰는 스냅샷 읽기(공급자 상태·번역 상태)도 여기 한 벌만 두고
 * `aiaSuggestions.ts`가 가져다 쓴다.
 */
import type {
  AccountSnapshot,
  ManagerSnapshot,
  ProviderStatus,
  SchedulerSnapshot,
  SystemAutomationSnapshot,
  TranslationStatus,
} from "../types";
import { DAY, HOUR, numberList, parsePersisted } from "./aiaPrimitives.ts";

export type AiaEventKind = "cliLost" | "accountAuthError" | "scheduleFailed" | "scheduleRecoveryError" | "translationFailed";

export interface AiaEvent {
  id: string;
  kind: AiaEventKind;
  targetId: string;
  priority: number;
  observedAt: number;
  summary: string;
  coalescedCount?: number;
}

export interface AiaEventBaseline {
  cliMissing: string[];
  authErrors: Record<string, string>;
  scheduleProblems: Record<string, string>;
  translationFailures: Record<string, string>;
}

export interface AiaEventTransitionResult {
  events: AiaEvent[];
  baseline: AiaEventBaseline;
}

export interface AiaEventBudget {
  dispatches: number[];
}

/** 기준선을 뜨는 데 필요한 스냅샷만. 제안 평가 입력을 그대로 넘겨도 받는다. */
export interface AiaEventSnapshotInput {
  manager: ManagerSnapshot;
  accounts: AccountSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  automation: SystemAutomationSnapshot | null;
}

/** 사건에는 관측 시각이 붙으므로 감지에는 `now`가 더 필요하다. */
export interface AiaEventDetectionInput extends AiaEventSnapshotInput {
  now: number;
}

/** 관리자 스냅샷과 시스템 자동화 스냅샷의 공급자 상태를 합친다. 자동화 쪽이 더 최신이다. */
export function providerStatuses(manager: ManagerSnapshot, automation: SystemAutomationSnapshot | null): ProviderStatus[] {
  const statuses = new Map<string, ProviderStatus>();
  for (const provider of manager.status.providers) statuses.set(provider.provider, provider);
  for (const provider of automation?.providers ?? []) statuses.set(provider.provider, provider);
  return [...statuses.values()];
}

export function translationEntries(automation: SystemAutomationSnapshot | null): Array<[string, TranslationStatus]> {
  if (!automation) return [];
  return [
    ["ui", automation.uiTranslation],
    ["skills", automation.skills],
    ["agents", automation.agents],
    ["artifacts", automation.artifacts],
  ];
}

/** 번역 상태 하나가 안고 있는 실패 건수. 묶음 실패와 문장 실패 중 큰 쪽을 본다. */
export function translationFailureCount(status: TranslationStatus): number {
  return Math.max(status.failed, status.segmentFailed);
}

/**
 * 목록에서 문제 상태만 골라 `대상 → 상태 문자열` 레코드로 모은다. 기준선의 세 항목이
 * 같은 모양의 순회를 각자 펼쳐 놓고 있어, 상태 문자열을 만드는 규칙만 남기고 순회는
 * 한 벌로 모았다.
 */
function stateRecord<T>(
  items: readonly T[],
  read: (item: T) => readonly [string, string] | null,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const item of items) {
    const entry = read(item);
    if (entry) record[entry[0]] = entry[1];
  }
  return record;
}

/**
 * 기준선 두 판을 견주어 사건으로 볼 항목만 남긴다. "새로 생겼는지"의 기준은 항목마다
 * 다르므로(처음 보는 키·상태 변화·실패 증가) 판정만 받는다.
 */
function changedStates(
  previous: Record<string, string>,
  current: Record<string, string>,
  changed: (previousState: string | undefined, currentState: string) => boolean,
): Array<[string, string]> {
  return Object.entries(current).filter(([key, state]) => changed(previous[key], state));
}

export function captureAiaEventBaseline(input: AiaEventSnapshotInput): AiaEventBaseline {
  const cliMissing = providerStatuses(input.manager, input.automation)
    .filter((provider) => !provider.cli.detected)
    .map((provider) => provider.provider)
    .sort();
  const authErrors = stateRecord(input.accounts?.accounts ?? [], (account) => (
    !account.disabled && account.authStatus !== "ready" ? [account.id, account.authStatus] : null
  ));
  const scheduleProblems = stateRecord(input.scheduler?.runs ?? [], (run) => (
    run.status === "failed" || run.recoveryError
      ? [run.id, `${run.status}:${run.recoveryError ? "recovery-error" : "none"}`]
      : null
  ));
  const translationFailures = stateRecord(translationEntries(input.automation), ([target, status]) => {
    const failed = translationFailureCount(status);
    return status.phase === "error" || failed > 0 ? [target, `${status.phase}:${failed}`] : null;
  });
  return { cliMissing, authErrors, scheduleProblems, translationFailures };
}

/**
 * 사건 종류별 규칙. 네 종류가 각자 "기준선에서 무엇을 꺼내 / 언제 새 사건으로 보고 /
 * 어떤 사건을 만드는가"만 다르고 순회는 같았다. 종류가 늘 때 같은 모양의 루프를 한 벌씩
 * 더 쓰는 대신 여기 한 줄을 더한다.
 *
 * CLI 미연결은 기준선을 목록으로 갖지만(저장 형태를 바꾸지 않는다) 견주는 방식은 나머지와
 * 같으므로, 읽을 때만 `대상 → 상태` 레코드로 옮겨 같은 순회에 태운다.
 */
const EVENT_RULES: ReadonlyArray<{
  states: (baseline: AiaEventBaseline) => Record<string, string>;
  changed: (previousState: string | undefined, currentState: string) => boolean;
  event: (targetId: string, state: string) => { kind: AiaEventKind; priority: number; summary: string };
}> = [
  {
    states: (baseline) => stateRecord(baseline.cliMissing, (provider) => [provider, "missing"]),
    changed: (before) => before === undefined,
    event: (provider) => ({ kind: "cliLost", priority: 100, summary: `${provider} CLI 연결이 끊겼습니다.` }),
  },
  {
    states: (baseline) => baseline.authErrors,
    changed: (before) => before === undefined,
    event: (_accountId, status) => ({
      kind: "accountAuthError",
      priority: 95,
      summary: `계정 인증 상태가 ${status}(으)로 변경되었습니다.`,
    }),
  },
  {
    states: (baseline) => baseline.scheduleProblems,
    changed: (before, state) => before !== state,
    event: (_runId, state) => {
      const recovery = state.endsWith("recovery-error");
      return {
        kind: recovery ? "scheduleRecoveryError" : "scheduleFailed",
        priority: recovery ? 90 : 80,
        summary: recovery
          ? "반복 요청 계정 복구 오류가 발생했습니다."
          : "반복 요청 실행이 실패하거나 건너뛰어졌습니다.",
      };
    },
  },
  {
    states: (baseline) => baseline.translationFailures,
    changed: translationFailureIncreased,
    event: (target) => ({ kind: "translationFailed", priority: 70, summary: `${target} 번역 실패가 발생했습니다.` }),
  },
];

export function detectAiaEvents(
  previous: AiaEventBaseline,
  input: AiaEventDetectionInput,
): AiaEventTransitionResult {
  const baseline = captureAiaEventBaseline(input);
  const events: AiaEvent[] = [];
  for (const rule of EVENT_RULES) {
    for (const [targetId, state] of changedStates(rule.states(previous), rule.states(baseline), rule.changed)) {
      const { kind, priority, summary } = rule.event(targetId, state);
      events.push(aiaEvent(kind, targetId, priority, input.now, summary));
    }
  }
  return { events: events.sort(compareEvents), baseline };
}

function translationFailureIncreased(previous: string | undefined, current: string): boolean {
  if (previous === undefined) return true;
  const [previousPhase, previousCountText] = previous.split(":");
  const [currentPhase, currentCountText] = current.split(":");
  const previousCount = Number(previousCountText) || 0;
  const currentCount = Number(currentCountText) || 0;
  return currentCount > previousCount || (previousPhase !== "error" && currentPhase === "error");
}

function aiaEvent(kind: AiaEventKind, targetId: string, priority: number, observedAt: number, summary: string): AiaEvent {
  return { id: `${kind}:${targetId}:${observedAt}`, kind, targetId, priority, observedAt, summary };
}

function compareEvents(left: AiaEvent, right: AiaEvent): number {
  return right.priority - left.priority || left.observedAt - right.observedAt || left.id.localeCompare(right.id);
}

/** 첫 사건으로부터 병합 시간이 지난 경우에만 가장 중요한 한 건을 반환한다. */
export function coalesceAiaEvents(events: AiaEvent[], now: number, windowMs = 30_000): AiaEvent | null {
  if (events.length === 0) return null;
  const oldest = Math.min(...events.map((event) => event.observedAt));
  if (now - oldest < Math.max(0, windowMs)) return null;
  const selected = [...events].sort(compareEvents)[0];
  return { ...selected, coalescedCount: events.length };
}

export function emptyAiaEventBudget(): AiaEventBudget {
  return { dispatches: [] };
}

export function parseAiaEventBudget(value: string | null | undefined): AiaEventBudget {
  return parsePersisted(value, emptyAiaEventBudget, null, (parsed) => ({ dispatches: numberList(parsed.dispatches) }));
}

export function serializeAiaEventBudget(budget: AiaEventBudget): string {
  return JSON.stringify({ dispatches: [...budget.dispatches].filter(Number.isFinite).sort((a, b) => a - b) });
}

/** 지금 시각 기준으로 롤링 창 안에 있는 발송 시각만 남긴다. 미래·비수치 값은 버린다. */
function dispatchesInWindow(budget: AiaEventBudget, now: number, rollingWindowMs: number): number[] {
  return budget.dispatches.filter((at) => Number.isFinite(at) && at <= now && now - at < rollingWindowMs);
}

export function canDispatchAiaEvent(
  budget: AiaEventBudget,
  now: number,
  minimumIntervalMs = 6 * HOUR,
  maximumPerWindow = 2,
  rollingWindowMs = DAY,
): boolean {
  const dispatches = dispatchesInWindow(budget, now, rollingWindowMs);
  const latest = Math.max(Number.NEGATIVE_INFINITY, ...dispatches);
  return dispatches.length < maximumPerWindow && now - latest >= minimumIntervalMs;
}

export function recordAiaEventDispatch(budget: AiaEventBudget, now: number, rollingWindowMs = DAY): AiaEventBudget {
  return { dispatches: [...dispatchesInWindow(budget, now, rollingWindowMs), now].sort((left, right) => left - right) };
}
