import type { ProviderId, UsageBudgetAccount, UsageBudgetConsumer } from "../types";
import { PROVIDER_IDS } from "./providerIds.ts";

/**
 * 워크플로 페이싱 탭의 카드가 보여 주는 파생 수치. 백엔드 스냅샷(`get_usage_budget`)에
 * 이미 들어 있는 값만 조합한다 — 새 조회도, 새 필드도 만들지 않는다.
 *
 * 계산을 컴포넌트에서 빼 두는 이유는 경계 조건이 조용히 틀리기 쉬워서다. 사용량을 못 읽은
 * 계정(usedPercent === null)은 평균에서 빠져야 하고, 참여 계정이 하나도 없으면 평균 자체가
 * 없으며, 회당 소비가 0이면 "남은 회차"는 무한이 아니라 답이 없다.
 */

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 페이싱에 참여하는 계정만. 풀 요약과 회차 대상 계산이 같은 판정을 쓴다. */
function pooledAccounts(accounts: UsageBudgetAccount[]): UsageBudgetAccount[] {
  return accounts.filter((account) => account.pacingEnabled);
}

/**
 * 이 창의 소진율. 스냅샷은 사용량을 못 읽은 계정에 null을 담고 구형 응답에는 필드 자체가
 * 없으므로, "잴 수 있는 값"의 판정을 한 곳에만 둔다. 여기서 number를 돌려준 계정만
 * 평균·최댓값에 들어가고, 그 덕에 호출부에 non-null 단언이 남지 않는다.
 */
function usedPercentOf(account: UsageBudgetAccount): number | null {
  const value = account.overview?.usedPercent;
  return typeof value === "number" ? value : null;
}

/** 소진율을 잴 수 있는 계정만 값과 함께. */
function measuredUsage(accounts: UsageBudgetAccount[]): { account: UsageBudgetAccount; usedPercent: number }[] {
  const measured: { account: UsageBudgetAccount; usedPercent: number }[] = [];
  for (const account of accounts) {
    const usedPercent = usedPercentOf(account);
    if (usedPercent !== null) measured.push({ account, usedPercent });
  }
  return measured;
}

/**
 * 잴 수 있는 계정만 본 창 소진율 평균. 풀 요약과 회차 요약이 같은 수치를 각자 조립하고
 * 있었는데, 평균 대상을 좁히는 규칙이 두 곳에 흩어져 있으면 한쪽만 고쳐진다.
 */
function averageUsedPercent(measured: { usedPercent: number }[]): number | null {
  return mean(measured.map((entry) => entry.usedPercent));
}

/** 순여유. 읽지 못한 계정은 여유가 없는 것으로 본다(회차를 더 돌 근거가 없다). */
function headroomOf(account: UsageBudgetAccount): number {
  return account.overview?.netHeadroomPercent ?? 0;
}

/** 유효한 창 초기화 시각(epoch ms). 없거나 0 이하면 null. */
function resetTimeOf(account: UsageBudgetAccount): number | null {
  const resetsAt = account.overview?.resetsAt;
  return typeof resetsAt === "number" && resetsAt > 0 ? resetsAt : null;
}

/** 계정 풀 정보카드가 쓰는 한 장짜리 요약. */
export interface PoolSummary {
  /** 페이싱에 참여하는 계정 수. */
  pooled: number;
  /** 등록된 전체 계정 수. */
  total: number;
  /** 참여 계정의 창 소진율 평균. 잴 수 있는 계정이 없으면 null. */
  averageUsedPercent: number | null;
  /** 참여 계정의 순여유 평균. */
  averageHeadroomPercent: number | null;
  /** 가장 많이 쓴 참여 계정. */
  busiest: { label: string; usedPercent: number } | null;
  /** 참여 계정 중 가장 먼저 초기화되는 창의 시각(epoch ms). */
  earliestResetAt: number | null;
  /** 참여 계정인데 비활성으로 꺼져 있는 수. 회차가 이 계정을 쓰지 못한다. */
  disabledCount: number;
  /** 참여 계정인데 이 창의 사용량을 읽지 못한 수. */
  unmeasuredCount: number;
}

export function poolSummary(accounts: UsageBudgetAccount[]): PoolSummary {
  const pooled = pooledAccounts(accounts);
  const measured = measuredUsage(pooled);
  const busiest = measured.reduce<{ label: string; usedPercent: number } | null>((best, entry) => {
    if (best && best.usedPercent >= entry.usedPercent) return best;
    return { label: accountLabel(entry.account), usedPercent: entry.usedPercent };
  }, null);
  const resets = pooled
    .map(resetTimeOf)
    .filter((value): value is number => value !== null);
  return {
    pooled: pooled.length,
    total: accounts.length,
    averageUsedPercent: averageUsedPercent(measured),
    averageHeadroomPercent: mean(pooled.map(headroomOf)),
    busiest,
    earliestResetAt: resets.length > 0 ? Math.min(...resets) : null,
    disabledCount: pooled.filter((account) => account.disabled).length,
    unmeasuredCount: pooled.length - measured.length,
  };
}

/**
 * 칩·모달이 함께 쓰는 계정 표시 이름. 좌측 메뉴 미터와 같은 이름을 쓰도록 설정에서 정한
 * 표시 이름을 우선하고, 그 값이 비어 있을 때만 이메일로 떨어진다.
 */
export function accountLabel(account: UsageBudgetAccount): string {
  return account.displayName || account.email || account.accountId;
}

/**
 * 이 회차가 실제로 쓰는 계정. `workflowAccounts`가 비어 있으면 제한 없음이라 풀 전체가
 * 대상이고, 풀이 비어 있으면(아무도 켜지 않았으면) 전 계정이 후보다 — 백엔드
 * `poolConfigured`가 false일 때의 규칙과 같다.
 */
export function consumerAccounts(
  consumer: Pick<UsageBudgetConsumer, "workflowAccounts">,
  accounts: UsageBudgetAccount[],
): UsageBudgetAccount[] {
  const pooled = pooledAccounts(accounts);
  const candidates = pooled.length > 0 ? pooled : accounts;
  const restricted = consumer.workflowAccounts ?? [];
  if (restricted.length === 0) return candidates;
  return candidates.filter((account) => restricted.includes(account.accountId));
}

/**
 * 페이싱 스케줄은 pacingSchedule로 옮겼다. 화면은 이 파일에서 요약 수치와 스케줄 문구를
 * 함께 가져오므로, 가져오는 자리를 흩지 않도록 이름만 그대로 다시 내보낸다.
 */
export {
  WEEKDAY_ORDER,
  WEEKDAY_NAMES,
  WEEKDAY_NAMES_EN,
  defaultQuietHours,
  quietWeekdays,
  describeWeekdays,
  describeQuietHours,
} from "./pacingSchedule.ts";

/** 회당 소비 표시값. 토큰이 없으면 공급자별 사용량 창의 %p 실측을 그대로 쓴다. */
export interface RunCost {
  provider: ProviderId;
  /** 최근 회차의 토큰 중앙값. 관측이 없거나 %p로만 재는 공급자면 null. */
  tokens: number | null;
  /** 실측 회당 소비(%p). 관측이 없으면 null. */
  percentPerRun: number | null;
}

/** 페이싱 회차 카드가 쓰는 요약. */
export interface ConsumerSummary {
  /** 이 회차가 쓰는 계정 수. */
  accountCount: number;
  /** 그 계정들의 창 소진율 평균. */
  averageUsedPercent: number | null;
  /** 공급자별 회당 소비. 실측이 있는 공급자만 담긴다. */
  costs: RunCost[];
  /**
   * 남은 순여유를 실측 회당 소비로 나눈 추정 회차 수. 공급자별로 계산해 더한다 —
   * 계정도 소비량도 공급자마다 다르므로 섞어 나누면 뜻이 없다. 실측이 없으면 null.
   */
  remainingRuns: number | null;
}

/**
 * 공급자별 순여유 합계. 공급자마다 계정 전체를 다시 거르지 않도록 한 번만 훑는다.
 * 실측이 없는 공급자는 키 자체가 없고, 읽는 쪽은 0으로 떨어진다.
 */
function headroomByProvider(accounts: UsageBudgetAccount[]): Map<ProviderId, number> {
  const totals = new Map<ProviderId, number>();
  for (const account of accounts) {
    totals.set(account.provider, (totals.get(account.provider) ?? 0) + headroomOf(account));
  }
  return totals;
}

/** 이 공급자의 회당 소비 한 줄. 토큰도 %p도 관측이 없으면 목록에 넣지 않는다(null). */
function runCostOf(consumer: UsageBudgetConsumer, provider: ProviderId): RunCost | null {
  const percentPerRun = consumer.costs?.perProvider?.[provider]?.percentPerRun ?? null;
  const tokens = consumer.costs?.savings?.[provider]?.currentTokens ?? null;
  if (percentPerRun === null && tokens === null) return null;
  return { provider, tokens, percentPerRun };
}

/**
 * 이 공급자로 더 돌 수 있는 회차 수. %p 실측이 없거나 0 이하면 나눌 근거가 없으므로
 * null이고, 호출부는 그 공급자를 합계에서 통째로 뺀다(0으로 세지 않는다).
 */
function providerRemainingRuns(cost: RunCost, headroom: number): number | null {
  if (cost.percentPerRun === null || cost.percentPerRun <= 0) return null;
  return Math.floor(headroom / cost.percentPerRun);
}

export function consumerSummary(
  consumer: UsageBudgetConsumer,
  accounts: UsageBudgetAccount[],
): ConsumerSummary {
  const used = consumerAccounts(consumer, accounts);
  const headroom = headroomByProvider(used);
  const costs: RunCost[] = [];
  let remainingRuns: number | null = null;
  for (const provider of PROVIDER_IDS) {
    const cost = runCostOf(consumer, provider);
    if (!cost) continue;
    costs.push(cost);
    const runs = providerRemainingRuns(cost, headroom.get(provider) ?? 0);
    if (runs !== null) remainingRuns = (remainingRuns ?? 0) + runs;
  }
  return {
    accountCount: used.length,
    averageUsedPercent: averageUsedPercent(measuredUsage(used)),
    costs,
    remainingRuns,
  };
}
