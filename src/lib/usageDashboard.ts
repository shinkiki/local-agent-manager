/**
 * 대시보드가 보여 주는 계정별 주간 소진율 행. 지금 값을 그리는 표시용 파생
 * (`accountUsage.ts`)과 달리 여기서는 등록된 여러 계정을 한 줄씩 늘어놓아 남은 주간
 * 한도를 견줄 수 있게 한다.
 *
 * 같은 화면의 월 구간별 누적 소비율은 `usageCumulative`가 소유한다. 화면이 보는 입구는
 * 이 모듈 하나로 두어(아래 재내보내기) 나눈 쪽의 사정이 화면의 import 목록으로 새어
 * 나가지 않게 한다.
 */
import type { AccountSnapshot, ProviderAccountView, ProviderId } from "../types";
import {
  accountUsageDisplayState,
  displayUsageWindows,
  governingUsageWindows,
  nextUsageReset,
  usageWindowValueUnavailable,
  type DisplayUsageWindow,
} from "./accountUsage.ts";
import { isWeeklyUsageWindow } from "./usageWindowLabel.ts";

export { isWeeklyUsageWindow, usageWindowLengthMs } from "./usageWindowLabel.ts";
export {
  cumulativeUsage,
  recentMonthPeriods,
  type CumulativeUsage,
  type MonthPeriod,
} from "./usageCumulative.ts";

type WeeklyUsageState =
  /** 최근 조회가 성공했고 수치를 그대로 믿을 수 있다. */
  | "ok"
  /** 마지막 조회는 실패했지만 이전 성공 수치를 유지해 보여 준다. */
  | "stale"
  /** 초기화 시각이 지난 뒤 조회까지 실패해 0%라고 단정할 수 없다. */
  | "unavailable"
  /** 보여 줄 수치가 없고 조회 오류만 있다. */
  | "error"
  /** 아직 한 번도 조회하지 않았다. */
  | "pending"
  /** 사용자가 중지한 계정. 소비가 일어나지 않으며 마지막 수치만 남는다. */
  | "disabled"
  /** 재인증이 필요해 조회할 수 없는 계정. */
  | "reauth";

export interface WeeklyUsageRow {
  account: ProviderAccountView;
  /** 일 단위 창들(보통 "7일" 하나, Claude는 "Fable 7일"이 더 붙는다). 초기화 경과 보정이 적용돼 있다. */
  windows: DisplayUsageWindow[];
  /** 대표 소진율 — 일 단위 창 중 최대. 믿을 수치가 없으면 null. */
  usedPercent: number | null;
  /** 아직 오지 않은 초기화 시각 중 가장 이른 것. */
  nextResetAt: number | null;
  state: WeeklyUsageState;
  /** 조회 실패 사유. `stale`·`error`·`unavailable`에서만 채운다. */
  error: string | null;
}

function weeklyUsageState(account: ProviderAccountView, windows: DisplayUsageWindow[], now: number): WeeklyUsageState {
  if (account.disabled) return "disabled";
  if (account.authStatus !== "ready") return "reauth";
  const display = accountUsageDisplayState(account, now);
  if (display.error !== null) return "error";
  if (windows.some((window) => usageWindowValueUnavailable(account.usage, window))) return "unavailable";
  if (display.staleError !== null) return "stale";
  if (account.usage.updatedAt === null) return "pending";
  return "ok";
}

/**
 * 상태 하나가 행의 두 칸에 대해 정하는 것. 수치를 보여 줄지와 조회 오류를 남길지는
 * 상태마다 답이 다른데, 그 답을 각각 `state !== ...` 나열로 적고 있었다. 두 나열이
 * 상태 목록과 따로 놀아서, 상태가 하나 늘 때 어느 쪽도 고치지 않아도 빌드가 통과하고
 * 새 상태는 조용히 "수치는 보이고 오류는 감춘다"로 떨어진다 — 어느 쪽도 그 상태를
 * 위해 고른 답이 아니다. `Record`가 상태를 모두 요구하므로 표로 두면 그 누락이 드러난다.
 */
interface WeeklyUsageStateRule {
  /** 대표 소진율을 숫자로 보여 줄 수 있는 상태인지. 보여 줄 창이 있는지는 따로 본다. */
  showsValue: boolean;
  /** 저장된 조회 오류를 행에 남기는 상태인지. */
  keepsError: boolean;
}

const WEEKLY_USAGE_STATE_RULES: Record<WeeklyUsageState, WeeklyUsageStateRule> = {
  ok: { showsValue: true, keepsError: false },
  // 이전 성공 수치를 그대로 보여 주면서, 그 값이 최신이 아닌 이유도 함께 알린다.
  stale: { showsValue: true, keepsError: true },
  unavailable: { showsValue: false, keepsError: true },
  error: { showsValue: false, keepsError: true },
  pending: { showsValue: false, keepsError: false },
  // 중지·재인증 계정은 소비가 일어나지 않을 뿐 마지막 수치는 그대로 믿을 수 있다.
  disabled: { showsValue: true, keepsError: false },
  reauth: { showsValue: true, keepsError: false },
};

/** 단일 계정의 주간 사용량 행을 구성한다. */
function buildWeeklyUsageRow(account: ProviderAccountView, now: number): WeeklyUsageRow {
  const windows = displayUsageWindows(account.usage.windows, now)
    .filter((window) => isWeeklyUsageWindow(window.label));
  // 대표 소진율과 상태는 계정 전체에 걸리는 창으로만 정한다. 모델별 창은 행에 그대로
  // 남아 화면에는 보이지만, 그 창 하나가 계정을 소진으로 보이게 하지는 않는다.
  const governing = governingUsageWindows(windows);
  const state = weeklyUsageState(account, governing, now);
  const rule = WEEKLY_USAGE_STATE_RULES[state];
  const usedPercent = rule.showsValue && governing.length > 0
    ? Math.max(...governing.map((window) => window.usedPercent))
    : null;
  const nextResetAt = nextUsageReset(governing, now);
  return { account, windows, usedPercent, nextResetAt, state, error: rule.keepsError ? account.usage.error : null };
}

/** 공급자 우선순위, 비활성화 여부, 소진율(내림차순), 표시 이름 순으로 행을 정렬한다. */
function compareWeeklyUsageRows(
  left: WeeklyUsageRow,
  right: WeeklyUsageRow,
  providerRank: (provider: ProviderId) => number,
): number {
  return (
    providerRank(left.account.provider) - providerRank(right.account.provider)
    || Number(left.account.disabled) - Number(right.account.disabled)
    || (right.usedPercent ?? -1) - (left.usedPercent ?? -1)
    || left.account.displayName.localeCompare(right.account.displayName, "ko")
  );
}

/**
 * 대시보드가 보여 주는 계정별 7일 누적 소진율. 활성 계정만 보이는 사이드바와 달리
 * 등록된 모든 계정을 늘어놓아, 남은 주간 한도가 어느 계정에 얼마나 있는지 한눈에
 * 비교할 수 있게 한다. 공급자 순서는 `providerOrder`를 따르고, 같은 공급자 안에서는
 * 쓸 수 있는 계정을 먼저, 그다음 소진율이 높은 순으로 둔다.
 */
export function weeklyUsageOverview(
  snapshot: AccountSnapshot | null,
  providerOrder: ProviderId[],
  now: number,
): WeeklyUsageRow[] {
  if (!snapshot) return [];
  const providerRank = (provider: ProviderId) => {
    const index = providerOrder.indexOf(provider);
    return index === -1 ? providerOrder.length : index;
  };
  return snapshot.accounts
    .map((account) => buildWeeklyUsageRow(account, now))
    .sort((left, right) => compareWeeklyUsageRows(left, right, providerRank));
}
