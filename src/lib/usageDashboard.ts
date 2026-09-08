/**
 * 대시보드가 보여 주는 사용량 집계 — 계정별 주간 소진율 행과, 월 구간별 누적 소비율
 * 계산. 지금 값을 그리는 표시용 파생(`accountUsage.ts`)과 달리 여기서는 여러 계정과
 * 지난 주기 이력을 걸쳐 합친다.
 */
import type { AccountSnapshot, AccountUsageHistory, ProviderAccountView, ProviderId } from "../types";
import {
  accountUsageDisplayState,
  displayUsageWindows,
  governingUsageWindows,
  nextUsageReset,
  usageWindowValueUnavailable,
  type DisplayUsageWindow,
} from "./accountUsage.ts";

/**
 * 창 라벨의 문법. 공급자는 창 라벨을 "7일", "Fable 7일", "5시간"처럼 실제 창 길이로
 * 만들므로(Codex Team은 primary가 7일일 수 있다) 고정 문자열이 아니라 라벨 끝의
 * `N일`·`N시간`·`N분`으로 읽는다. 백엔드 `usage_history::window_length_from_label`과
 * 같은 규칙이라 이력의 주기 길이와 현재 창의 길이가 같은 단위로 맞는다.
 *
 * 이 문법을 아는 곳은 여기 하나다 — 주기 단위를 보는 곳과 길이를 재는 곳이 각자
 * 정규식을 들고 있으면 공급자가 라벨 모양을 바꿀 때 한쪽만 따라가게 된다.
 */
const USAGE_WINDOW_LABEL_PATTERN = /(\d+)(일|시간|분)$/u;

/** 단위별 길이(ms). */
const USAGE_WINDOW_UNIT_MS = { 일: 86_400_000, 시간: 3_600_000, 분: 60_000 } as const;

type UsageWindowUnit = keyof typeof USAGE_WINDOW_UNIT_MS;

function parseUsageWindowLabel(label: string): { count: number; unit: UsageWindowUnit } | null {
  const match = USAGE_WINDOW_LABEL_PATTERN.exec(label.trim());
  if (!match) return null;
  return { count: Number(match[1]), unit: match[2] as UsageWindowUnit };
}

/** 일 단위로 초기화되는 사용량 창인지. 5시간 창은 여기서 빠진다. */
export function isWeeklyUsageWindow(label: string): boolean {
  return parseUsageWindowLabel(label)?.unit === "일";
}

export type WeeklyUsageState =
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
  const rows = snapshot.accounts.map((account): WeeklyUsageRow => {
    const windows = displayUsageWindows(account.usage.windows, now)
      .filter((window) => isWeeklyUsageWindow(window.label));
    // 대표 소진율과 상태는 계정 전체에 걸리는 창으로만 정한다. 모델별 창은 행에 그대로
    // 남아 화면에는 보이지만, 그 창 하나가 계정을 소진으로 보이게 하지는 않는다.
    const governing = governingUsageWindows(windows);
    const state = weeklyUsageState(account, governing, now);
    const showsValue = governing.length > 0 && state !== "error" && state !== "unavailable" && state !== "pending";
    const usedPercent = showsValue ? Math.max(...governing.map((window) => window.usedPercent)) : null;
    const nextResetAt = nextUsageReset(governing, now);
    const error = state === "stale" || state === "error" || state === "unavailable" ? account.usage.error : null;
    return { account, windows, usedPercent, nextResetAt, state, error };
  });
  const providerRank = (provider: ProviderId) => {
    const index = providerOrder.indexOf(provider);
    return index === -1 ? providerOrder.length : index;
  };
  return rows.sort((left, right) => (
    providerRank(left.account.provider) - providerRank(right.account.provider)
    || Number(left.account.disabled) - Number(right.account.disabled)
    || (right.usedPercent ?? -1) - (left.usedPercent ?? -1)
    || left.account.displayName.localeCompare(right.account.displayName, "ko")
  ));
}

/** 창 라벨에서 주기 길이(ms)를 읽는다. 길이가 0 이하면 주기로 쓸 수 없어 null이다. */
export function usageWindowLengthMs(label: string): number | null {
  const parsed = parseUsageWindowLabel(label);
  if (!parsed || !Number.isFinite(parsed.count) || parsed.count <= 0) return null;
  return parsed.count * USAGE_WINDOW_UNIT_MS[parsed.unit];
}

export interface UsagePeriod {
  from: number;
  to: number;
}

export interface MonthPeriod extends UsagePeriod {
  /** `YYYY-MM`. 열 키로 쓴다. */
  key: string;
  /** 축 라벨(`N월`). 연도는 붙이지 않는다 — 최근 6개월 안에서는 달만으로 구분된다. */
  label: string;
}

/**
 * 이번 달을 포함한 최근 `count`개 달력 달, 오래된 달부터. 이번 달은 지금까지로 자른다 —
 * 오지 않은 날에는 공급자가 준 제공량도 없다.
 */
export function recentMonthPeriods(now: number, count: number): MonthPeriod[] {
  const current = new Date(now);
  const months: MonthPeriod[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const start = new Date(current.getFullYear(), current.getMonth() - offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const month = start.getMonth() + 1;
    months.push({
      key: `${start.getFullYear()}-${String(month).padStart(2, "0")}`,
      label: `${month}월`,
      from: start.getTime(),
      to: Math.min(end.getTime(), now),
    });
  }
  return months;
}

export interface CumulativeUsageWindow {
  label: string;
  windowLengthMs: number;
  /** 기간 안에 공급자가 준 주기 수. 부분 주기는 비율로 센다. */
  budgetCycles: number;
  /** 소비한 제공량을 주기 수로 환산한 값(Σ 최대 소진율 × 기간과 겹친 비율). */
  consumedCycles: number;
  /** 소비율(%) = consumedCycles / budgetCycles. */
  consumedPercent: number;
  /** 기간과 겹친 주기 레코드 수. */
  cycleCount: number;
}

export interface CumulativeUsage {
  /** 실제로 계산한 구간. 관측이 요청 기간보다 늦게 시작했으면 앞이 잘린다. */
  from: number;
  to: number;
  truncated: boolean;
  windows: CumulativeUsageWindow[];
  /** 대표 소비율: 창들 중 최대. 계산할 구간이 없으면 null. */
  consumedPercent: number | null;
}

/**
 * 기간 동안 공급자가 준 주기별 제공량(주기마다 100%)을 얼마나 소비했는지.
 *
 * 분모는 고정 7일이 아니라 각 창의 실제 주기 길이로 기간을 나눈 주기 수다 — Codex 플랜에
 * 따라 창 길이가 다르고, 공급자가 주기를 바꾸면 이력의 주기 길이가 따라온다. 분자는
 * 주기마다 남은 최대 소진율을 그 주기가 기간과 겹친 비율만큼만 더한다. 그래서 진행 중인
 * 주기는 지금까지의 비율로, 경계에 걸친 주기는 걸친 만큼만 들어가고, 아무 소비가 없어
 * 레코드조차 없는 주는 0으로 남아 분모만 키운다.
 *
 * 관측 시작(`observedSince`) 이전은 소비가 없었던 것이 아니라 모르는 것이므로 구간을
 * 거기서 시작하고 `truncated`로 알린다. `currentLabels`는 계정의 현재 창 라벨이라,
 * 이력에 레코드가 하나도 없는 창(아직 한 번도 쓰지 않은 계정)도 0%로 나타난다.
 */
export function cumulativeUsage(
  history: AccountUsageHistory | null,
  currentLabels: string[],
  period: UsagePeriod,
): CumulativeUsage | null {
  if (!history) return null;
  const from = Math.max(period.from, history.observedSince);
  const to = period.to;
  const truncated = history.observedSince > period.from;
  if (from >= to) return { from, to, truncated, windows: [], consumedPercent: null };
  const windows = [...cumulativeWindowLengths(history, currentLabels).entries()]
    .map(([label, windowLengthMs]) => cumulativeWindow(history, label, windowLengthMs, { from, to }));
  return {
    from,
    to,
    truncated,
    windows,
    consumedPercent: windows.length > 0 ? Math.max(...windows.map((window) => window.consumedPercent)) : null,
  };
}

/**
 * 소비율을 계산할 창과 그 주기 길이. 계정의 현재 창 라벨과 이력에 남은 창을 합치되,
 * 하루보다 짧은 현재 창(5시간)은 누적 소비율의 대상이 아니라 제외한다.
 */
function cumulativeWindowLengths(
  history: AccountUsageHistory,
  currentLabels: string[],
): Map<string, number> {
  const labels = new Map<string, number>();
  for (const label of currentLabels) {
    const length = usageWindowLengthMs(label);
    if (length !== null && length >= 86_400_000) labels.set(label, length);
  }
  // 이력의 주기 길이가 우선한다 — 공급자가 실제로 준 주기다.
  for (const cycle of history.cycles) labels.set(cycle.windowLabel, cycle.windowLengthMs);
  return labels;
}

/**
 * 창 하나의 소비율. 기간과 겹친 주기마다 그 주기의 최대 소진율을 겹친 비율만큼만 더해,
 * 진행 중인 주기는 지금까지의 비율로, 경계에 걸친 주기는 걸친 만큼만 들어가게 한다.
 */
function cumulativeWindow(
  history: AccountUsageHistory,
  label: string,
  windowLengthMs: number,
  period: UsagePeriod,
): CumulativeUsageWindow {
  const budgetCycles = (period.to - period.from) / windowLengthMs;
  let consumedCycles = 0;
  let cycleCount = 0;
  for (const cycle of history.cycles) {
    if (cycle.windowLabel !== label) continue;
    const cycleStart = cycle.resetsAt - cycle.windowLengthMs;
    const overlap = Math.min(cycle.resetsAt, period.to) - Math.max(cycleStart, period.from);
    if (overlap <= 0) continue;
    cycleCount += 1;
    consumedCycles += (cycle.peakUsedPercent / 100) * (overlap / cycle.windowLengthMs);
  }
  return {
    label,
    windowLengthMs,
    budgetCycles,
    consumedCycles,
    consumedPercent: budgetCycles > 0 ? Math.max(0, (consumedCycles / budgetCycles) * 100) : 0,
    cycleCount,
  };
}
