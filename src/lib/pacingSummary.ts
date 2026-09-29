import type { ProviderId, UsageBudgetAccount, UsageBudgetConsumer } from "../types";
import {
  averageHeadroomPercent,
  averageUsedPercent,
  busiestUsage,
  disabledCount,
  earliestResetAt,
  headroomOf,
  measuredUsage,
  pooledAccounts,
  type BusiestUsage,
} from "./pacingAccounts.ts";
import { hasUsageQuota, PROVIDER_IDS } from "./providerIds.ts";

/**
 * 페이싱 계산이 다루는 공급자. 사용량 한도가 없는 공급자는 창도 리셋 시각도 없어 소진율을
 * 잴 수 없다 — 목록에 남겨 두면 0%로 읽혀 "여유가 가장 많은 계정"으로 뽑히고, 빈 필터
 * 폴백에서는 있지도 않은 레인이 생긴다.
 */
export const PACING_PROVIDER_IDS: readonly ProviderId[] = PROVIDER_IDS.filter(hasUsageQuota);

/**
 * 워크플로 페이싱 탭의 카드가 보여 주는 파생 수치. 백엔드 스냅샷(`get_usage_budget`)에
 * 이미 들어 있는 값만 조합한다 — 새 조회도, 새 필드도 만들지 않는다.
 *
 * 계정 한 건에서 무엇을 읽을 수 있고 그 값이 없을 때 무슨 뜻인지는 `pacingAccounts`가
 * 정한다. 여기 있는 것은 그 값들을 카드 한 장의 모양으로 조립하는 규칙뿐이라, 화면이
 * 담을 수치가 달라질 때만 손댄다.
 */

/** 계정 풀 정보카드가 쓰는 한 장짜리 요약. */
export interface PoolSummary {
  /** 페이싱에 참여하는 계정 수. */
  pooled: number;
  /** 등록된 전체 계정 수. */
  total: number;
  /** 참여 계정의 창 소진율 평균. 잴 수 있는 계정이 없으면 null. */
  averageUsedPercent: number | null;
  /** 참여 계정의 순여유 평균. 소진율 평균과 같은 계정(잴 수 있는 계정)만 본다. */
  averageHeadroomPercent: number | null;
  /** 가장 많이 쓴 참여 계정. */
  busiest: BusiestUsage | null;
  /** 참여 계정 중 가장 먼저 초기화되는 창의 시각(epoch ms). 모두 지났으면 null. */
  earliestResetAt: number | null;
  /** 참여 계정인데 비활성으로 꺼져 있는 수. 회차가 이 계정을 쓰지 못한다. */
  disabledCount: number;
  /** 참여 계정인데 이 창의 사용량을 읽지 못한 수. */
  unmeasuredCount: number;
}

export function poolSummary(accounts: UsageBudgetAccount[], now: number = Date.now()): PoolSummary {
  const pooled = pooledAccounts(accounts);
  const measured = measuredUsage(pooled);
  return {
    pooled: pooled.length,
    total: accounts.length,
    averageUsedPercent: averageUsedPercent(measured),
    averageHeadroomPercent: averageHeadroomPercent(measured),
    busiest: busiestUsage(measured),
    earliestResetAt: earliestResetAt(pooled, now),
    disabledCount: disabledCount(pooled),
    unmeasuredCount: pooled.length - measured.length,
  };
}

/**
 * 이 회차가 실제로 쓰는 계정. `workflowAccounts`가 비어 있으면 제한 없음이라 풀 전체가
 * 대상이고, 풀이 비어 있으면(아무도 켜지 않았으면) 전 계정이 후보다 — 백엔드
 * `poolConfigured`가 false일 때의 규칙과 같다.
 *
 * 이 목록은 파일 밖으로 내보내지 않는다. 화면이 쓰는 모양은 아래 `consumerSummary`가
 * 내는 파생 수치뿐이고, 고른 계정까지 함께 내주면 요약을 거치지 않고 대상 계정을 세는
 * 두 번째 경로가 열린다 — 그 경로에는 풀이 비었을 때의 후보 규칙이 다시 적힐 자리가
 * 생긴다. 실제로 이 진입점을 부르던 것은 자기 테스트뿐이었고, 그 시험은 요약의
 * 계정 수와 소진율 평균으로 같은 사실을 짚는다. 합친 결과를 내주지 않는
 * `projectRegistry`, 중간 단계를 닫아 둔 `navigationPreferences`와 같은 경계다.
 */
function consumerAccounts(
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
 * 계정 표시 이름은 pacingAccounts로, 페이싱 스케줄은 pacingSchedule로 옮겼다. 화면은 이
 * 파일에서 요약 수치와 그 둘을 함께 가져오므로, 가져오는 자리를 흩지 않도록 이름만
 * 그대로 다시 내보낸다.
 */
export { accountLabel } from "./pacingAccounts.ts";

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

/**
 * 공급자별 실측 비용 목록과 그 비용으로 더 돌 수 있는 회차 합계.
 *
 * 소비자 요약은 계정 수·평균 소진율도 함께 만들지만, 이 두 값은 공급자 순회나 순여유
 * 합산 규칙을 알 필요가 없다. 비용을 고르는 일과 남은 회차를 더하는 일을 한 덩어리로
 * 가르면 `consumerSummary`는 계정 파생값을 조립하는 자리로만 남고, 비용의 null·0 경계는
 * 이 함수 안에서 서로 붙어 움직인다.
 */
function consumerCostSummary(
  consumer: UsageBudgetConsumer,
  headroom: ReadonlyMap<ProviderId, number>,
): Pick<ConsumerSummary, "costs" | "remainingRuns"> {
  const costs: RunCost[] = [];
  let remainingRuns: number | null = null;
  for (const provider of PACING_PROVIDER_IDS) {
    const cost = runCostOf(consumer, provider);
    if (!cost) continue;
    costs.push(cost);
    const runs = providerRemainingRuns(cost, headroom.get(provider) ?? 0);
    if (runs !== null) remainingRuns = (remainingRuns ?? 0) + runs;
  }
  return { costs, remainingRuns };
}

export function consumerSummary(
  consumer: UsageBudgetConsumer,
  accounts: UsageBudgetAccount[],
): ConsumerSummary {
  const used = consumerAccounts(consumer, accounts);
  return {
    accountCount: used.length,
    averageUsedPercent: averageUsedPercent(measuredUsage(used)),
    ...consumerCostSummary(consumer, headroomByProvider(used)),
  };
}
