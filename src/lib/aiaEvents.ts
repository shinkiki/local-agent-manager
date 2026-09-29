/**
 * AIA 사건 감지. 제안 평가(`aiaSuggestions.ts`)와 같은 스냅샷을 읽지만
 * 하는 일이 다르다 — 제안은 "지금 상태가 규칙에 걸리는가"를 보고, 사건은 "직전 판과
 * 견주어 무엇이 새로 나빠졌는가"를 본다. 한 파일에 섞여 있어 제안 규칙을 고칠 때
 * 사건 기준선까지 함께 읽어야 했으므로 여기로 떼어냈다.
 *
 * 두 쪽이 함께 쓰는 것은 스냅샷 읽기가 아니라 **문제 질의**다 — "지금 CLI가 끊긴
 * 공급자는 누구인가", "실패 건수가 임계에 닿은 번역 대상은 무엇인가". 스냅샷을 펼치는
 * 낮은 단계 읽기를 내보내면 그 위의 판정(무엇을 문제로 볼지, 상태를 어떤 문자열로
 * 적을지)이 사건 쪽과 제안 쪽에 두 벌로 생긴다. 그래서 읽기는 이 모듈 안에 감추고
 * 질의만 내보내며, `aiaSuggestionRules.ts`가 그것을 가져다 쓴다.
 *
 * 감지된 사건을 몇 번까지 알릴지 세는 발송 예산은 `aiaEventBudget.ts`가 갖는다. 그쪽은
 * 스냅샷을 전혀 보지 않고 발송 시각 목록만 다루므로 여기 있을 이유가 없었다.
 */
import type {
  AccountSnapshot,
  ManagerSnapshot,
  ProviderStatus,
  SchedulerSnapshot,
  SystemAutomationSnapshot,
  TranslationStatus,
} from "../types";

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
function providerStatuses(manager: ManagerSnapshot, automation: SystemAutomationSnapshot | null): ProviderStatus[] {
  const statuses = new Map<string, ProviderStatus>();
  for (const provider of manager.status.providers) statuses.set(provider.provider, provider);
  for (const provider of automation?.providers ?? []) statuses.set(provider.provider, provider);
  return [...statuses.values()];
}

/**
 * CLI가 감지되지 않은 공급자. 사건 기준선의 `cliMissing`과 제안 후보가 같은 목록을 봐야
 * 한다 — 한쪽만 자동화 스냅샷을 덮어 읽으면 제안은 뜨는데 사건은 나지 않거나 그 반대가 된다.
 */
export function cliMissingProviders(
  manager: ManagerSnapshot,
  automation: SystemAutomationSnapshot | null,
): ProviderStatus[] {
  return providerStatuses(manager, automation).filter((provider) => !provider.cli.detected);
}

function translationEntries(automation: SystemAutomationSnapshot | null): Array<[string, TranslationStatus]> {
  if (!automation) return [];
  return [
    ["ui", automation.uiTranslation],
    ["skills", automation.skills],
    ["agents", automation.agents],
    ["artifacts", automation.artifacts],
  ];
}

/** 번역 상태 하나가 안고 있는 실패 건수. 묶음 실패와 문장 실패 중 큰 쪽을 본다. */
function translationFailureCount(status: TranslationStatus): number {
  return Math.max(status.failed, status.segmentFailed);
}

/** 실패가 임계에 닿은 번역 대상 하나. */
export interface FailingTranslation {
  target: string;
  failed: number;
  /** `단계:실패수`. 사건 기준선의 상태 문자열과 제안의 상태 키가 이 한 벌을 함께 쓴다. */
  stateKey: string;
}

/**
 * 실패한 번역 대상만 남긴다. 오류 단계는 실패 건수와 무관하게 언제나 문제로 보고, 그
 * 밖에는 `minFailureCount`에 닿은 것만 센다(기준선은 한 건이라도 있으면 문제다).
 *
 * 대상을 고르는 조건과 상태 문자열이 사건 쪽·제안 쪽에 각자 펼쳐져 있었다. 상태 문자열은
 * 한쪽은 기준선 비교에, 다른 쪽은 숨김 지문에 쓰이는데 모양이 갈리면 같은 실패가 두
 * 화면에서 다른 사건으로 읽힌다. 판정과 문자열을 여기 한 벌만 둔다.
 */
export function failingTranslations(
  automation: SystemAutomationSnapshot | null,
  minFailureCount = 1,
): FailingTranslation[] {
  return translationEntries(automation).flatMap(([target, status]) => {
    const failed = translationFailureCount(status);
    if (status.phase !== "error" && failed < minFailureCount) return [];
    return [{ target, failed, stateKey: translationState(status.phase, failed) }];
  });
}

/**
 * 기준선이 상태를 문자열 한 줄로 적는 것은 저장과 비교가 쉬워서다. 그런데 그 한 줄을
 * 조립하는 곳과 도로 뜯어 읽는 곳이 파일 양 끝에 떨어져 있었다 — 번역 실패는 여기서
 * 붙이고 `translationFailureIncreased`가 `split(":")`으로 풀었고, 반복 요청 문제는
 * `captureAiaEventBaseline`이 붙이고 규칙표가 `endsWith`로 꼬리만 훑었다. 조립 쪽 문구를
 * 하나 바꾸면 해독 쪽은 오류 없이 조용히 "달라지지 않았다"로 읽어 사건이 통째로 나지
 * 않으므로, 갈래마다 조립과 해독을 붙여 둔 한 쌍으로 두고 밖에서는 문자열 모양을 모른다.
 */
function translationState(phase: string, failed: number): string {
  return `${phase}:${failed}`;
}

function readTranslationState(state: string): { phase: string; failed: number } {
  const [phase = "", failedText] = state.split(":");
  return { phase, failed: Number(failedText) || 0 };
}

/** 반복 요청 문제 상태의 복구 오류 자리에 적는 값. 복구 오류가 없으면 `none`이다. */
const SCHEDULE_RECOVERY_ERROR = "recovery-error";

function scheduleProblemState(status: string, recoveryError: boolean): string {
  return `${status}:${recoveryError ? SCHEDULE_RECOVERY_ERROR : "none"}`;
}

function readScheduleProblemState(state: string): { status: string; recoveryError: boolean } {
  const [status = "", recovery] = state.split(":");
  return { status, recoveryError: recovery === SCHEDULE_RECOVERY_ERROR };
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
  const cliMissing = cliMissingProviders(input.manager, input.automation)
    .map((provider) => provider.provider)
    .sort();
  const authErrors = stateRecord(input.accounts?.accounts ?? [], (account) => (
    !account.disabled && account.authStatus !== "ready" ? [account.id, account.authStatus] : null
  ));
  const scheduleProblems = stateRecord(input.scheduler?.runs ?? [], (run) => (
    run.status === "failed" || run.recoveryError
      ? [run.id, scheduleProblemState(run.status, Boolean(run.recoveryError))]
      : null
  ));
  const translationFailures = stateRecord(
    failingTranslations(input.automation),
    (translation) => [translation.target, translation.stateKey],
  );
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
      const { recoveryError: recovery } = readScheduleProblemState(state);
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
  const before = readTranslationState(previous);
  const now = readTranslationState(current);
  return now.failed > before.failed || (before.phase !== "error" && now.phase === "error");
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
