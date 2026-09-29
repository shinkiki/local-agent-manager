/**
 * 월 구간별 누적 소비율 — 기간 동안 공급자가 준 주기별 제공량을 얼마나 소비했는지.
 *
 * 계정별 주간 소진율 행(`usageDashboard`)과는 서로 읽을 것이 없다. 저쪽은 지금 등록된
 * 계정들의 **현재** 창을 한 줄씩 늘어놓아 남은 한도를 견주는 일이고, 여기는 계정 하나의
 * **지난 주기 이력**을 달력 구간에 겹쳐 비율로 접는 일이다. 보는 재료(계정 목록 대
 * 주기 레코드)도, 답이 달라지는 이유(조회 상태 대 주기 경계)도 겹치지 않는다.
 *
 * 한 파일에 두면 소비율 분모를 고치러 들어온 사람이 조회 실패 상태표를, 상태를 하나
 * 늘리러 온 사람이 주기 겹침 산식을 함께 읽게 된다. 둘이 같이 쓰는 것은 창 라벨의
 * 문법뿐이라 그것만 `usageWindowLabel`에 두고 나머지를 갈랐다.
 */
import { usageWindowLengthMs, USAGE_WINDOW_UNIT_MS } from "./usageWindowLabel.ts";
import type { AccountUsageHistory } from "../types";

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
  const windows = [...cumulativeWindowSources(history, currentLabels).entries()]
    .map(([label, source]) => cumulativeWindow(label, source, { from, to }));
  return {
    from,
    to,
    truncated,
    windows,
    consumedPercent: windows.length > 0 ? Math.max(...windows.map((window) => window.consumedPercent)) : null,
  };
}

/** 이력에 남은 주기 레코드 한 건. */
type UsageCycle = AccountUsageHistory["cycles"][number];

/** 창 하나의 소비율을 계산할 재료 — 주기 길이와 그 창에 속한 주기 레코드. */
interface CumulativeWindowSource {
  windowLengthMs: number;
  cycles: UsageCycle[];
}

/**
 * 소비율을 계산할 창과 그 재료. 계정의 현재 창 라벨과 이력에 남은 창을 합치되,
 * 하루보다 짧은 현재 창(5시간)은 누적 소비율의 대상이 아니라 제외한다.
 *
 * 주기 레코드를 여기서 창별로 갈라 둔다. 창마다 이력 전체를 다시 훑으면 "이 라벨의
 * 주기인가"라는 같은 판정이 창 수만큼 되풀이되고, 창이 늘수록 훑는 횟수가 곱으로 는다 —
 * 계정 하나가 6개월 치 주기를 들고 모델별 창까지 붙는 자리라 그 곱이 그대로 화면에 걸린다.
 */
function cumulativeWindowSources(
  history: AccountUsageHistory,
  currentLabels: string[],
): Map<string, CumulativeWindowSource> {
  const sources = new Map<string, CumulativeWindowSource>();
  for (const label of currentLabels) {
    const windowLengthMs = usageWindowLengthMs(label);
    if (windowLengthMs !== null && windowLengthMs >= USAGE_WINDOW_UNIT_MS.일) {
      sources.set(label, { windowLengthMs, cycles: [] });
    }
  }
  for (const cycle of history.cycles) {
    const source = sources.get(cycle.windowLabel);
    if (!source) {
      sources.set(cycle.windowLabel, { windowLengthMs: cycle.windowLengthMs, cycles: [cycle] });
      continue;
    }
    // 이력의 주기 길이가 우선한다 — 공급자가 실제로 준 주기다.
    source.windowLengthMs = cycle.windowLengthMs;
    source.cycles.push(cycle);
  }
  return sources;
}

/**
 * 주기가 대상 기간과 겹친 만큼의 소비 주기 수(0~1). 겹치지 않으면 null이다 —
 * 소비가 0인 주기(0)와 이 기간에 들지 않는 주기를 값으로 구분해야, 세는 쪽이
 * 겹침 여부를 다시 판정하지 않고 그대로 건너뛸 수 있다.
 */
function cycleOverlapCycles(cycle: UsageCycle, period: UsagePeriod): number | null {
  const cycleStart = cycle.resetsAt - cycle.windowLengthMs;
  const overlap = Math.min(cycle.resetsAt, period.to) - Math.max(cycleStart, period.from);
  if (overlap <= 0) return null;
  return (cycle.peakUsedPercent / 100) * (overlap / cycle.windowLengthMs);
}

/**
 * 창 하나의 소비율. 기간과 겹친 주기마다 그 주기의 최대 소진율을 겹친 비율만큼만 더해,
 * 진행 중인 주기는 지금까지의 비율로, 경계에 걸친 주기는 걸친 만큼만 들어가게 한다.
 */
function cumulativeWindow(
  label: string,
  source: CumulativeWindowSource,
  period: UsagePeriod,
): CumulativeUsageWindow {
  const budgetCycles = (period.to - period.from) / source.windowLengthMs;
  let consumedCycles = 0;
  let cycleCount = 0;
  for (const cycle of source.cycles) {
    const cycleConsumed = cycleOverlapCycles(cycle, period);
    if (cycleConsumed === null) continue;
    cycleCount += 1;
    consumedCycles += cycleConsumed;
  }
  return {
    label,
    windowLengthMs: source.windowLengthMs,
    budgetCycles,
    consumedCycles,
    consumedPercent: budgetCycles > 0 ? Math.max(0, (consumedCycles / budgetCycles) * 100) : 0,
    cycleCount,
  };
}
