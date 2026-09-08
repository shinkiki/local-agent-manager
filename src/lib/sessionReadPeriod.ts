import type { SessionReadPeriod, SessionReadRelativeUnit } from "../types";
import { clampSessionReadCount, SESSION_READ_DEFAULTS } from "./sessionReadLimits.ts";

/**
 * 세션 참조 기간의 어휘 한 벌 — 선택지 표, 표시 문구, 선택지와 저장값 사이의 왕복, 저장 전
 * 자르기, 비교용 열쇠. 기간은 종류마다 딸린 값이 달라서 어느 한 곳을 고치면 나머지도 같이
 * 봐야 하는데, 정책 전체를 다루는 파일에 섞여 있던 동안에는 그 다섯이 파일 곳곳에 흩어져
 * 있어 단위를 하나 늘리는 일이 파일 전체를 훑는 일이 됐다.
 */

/**
 * 상대 기간 선택지 하나가 갖는 모든 대응 — 선택지 값, 정책의 상대 단위, 한 단위일 때의
 * 표시 문구, 여러 단위일 때 붙는 단위 이름. 예전에는 이 네 가지가 선택지 목록·요약
 * 문구·선택지 판정·선택지 되돌리기 네 곳에 흩어져 있어, 단위를 하나 늘리려면 네 곳을
 * 모두 같은 순서로 고쳐야 했다.
 */
const RELATIVE_PERIOD_CHOICES = [
  { value: "lastDay", unit: "day", label: "어제", pluralSuffix: "일" },
  { value: "lastWeek", unit: "week", label: "지난주", pluralSuffix: "주" },
  { value: "lastMonth", unit: "month", label: "지난달", pluralSuffix: "개월" },
] as const satisfies readonly {
  value: string;
  unit: SessionReadRelativeUnit;
  label: string;
  pluralSuffix: string;
}[];

type RelativePeriodChoice = (typeof RELATIVE_PERIOD_CHOICES)[number];

/**
 * 표를 두 방향으로 세운 색인. 단위로 찾는 자리가 두 곳, 선택지 값으로 찾는 자리가 한 곳
 * 있는데, 셋이 각자 `find`를 적던 동안에는 같은 표를 어떤 열로 읽는지가 호출부마다
 * 흩어져 있었고 단위 조회 두 곳의 폴백이 서로 달라도 나란히 놓고 볼 수 없었다.
 * 조회는 여기로 모으고, 무엇으로 되돌릴지는 그 답이 필요한 호출부가 정한다.
 */
const RELATIVE_CHOICE_BY_UNIT: ReadonlyMap<SessionReadRelativeUnit, RelativePeriodChoice> =
  new Map(RELATIVE_PERIOD_CHOICES.map((choice) => [choice.unit, choice] as const));

const RELATIVE_CHOICE_BY_VALUE: ReadonlyMap<string, RelativePeriodChoice> =
  new Map(RELATIVE_PERIOD_CHOICES.map((choice) => [choice.value, choice] as const));

export type SessionReadPeriodChoice =
  | "reportPeriod"
  | "recentDays"
  | "absoluteRange"
  | RelativePeriodChoice["value"];

/** 편집기가 고르게 하는 기간 표현. 스케줄 모델과 같은 어휘를 쓴다. */
export const SESSION_READ_PERIOD_CHOICES: readonly {
  value: SessionReadPeriodChoice;
  label: string;
}[] = [
  { value: "reportPeriod", label: "보고기간(직전 실행 이후)" },
  ...RELATIVE_PERIOD_CHOICES.map(({ value, label }) => ({ value, label })),
  { value: "recentDays", label: "최근 N일" },
  { value: "absoluteRange", label: "직접 범위" },
];

export function sessionReadPeriodChoice(period: SessionReadPeriod): SessionReadPeriodChoice {
  if (period.kind === "recentDays") return "recentDays";
  if (period.kind === "absoluteRange") return "absoluteRange";
  if (period.kind === "relative") {
    // 한 단위만 선택지로 두므로, 2주처럼 표에 없는 값은 숫자를 직접 적는 쪽으로 보낸다.
    if (period.count !== 1) return "recentDays";
    // 선택지에 없는 단위는 표시할 항목이 없으므로 숫자를 직접 적는 쪽으로 보낸다.
    return RELATIVE_CHOICE_BY_UNIT.get(period.unit)?.value ?? "recentDays";
  }
  return "reportPeriod";
}

/** 선택지를 실제 정책 값으로 바꾼다. 기존 값이 있으면 같은 종류의 숫자를 물려받는다. */
export function sessionReadPeriodFromChoice(
  choice: SessionReadPeriodChoice,
  current: SessionReadPeriod,
): SessionReadPeriod {
  const relative = RELATIVE_CHOICE_BY_VALUE.get(choice);
  if (relative) {
    return { kind: "relative", unit: relative.unit, count: SESSION_READ_DEFAULTS.relativeCount };
  }
  switch (choice) {
    case "recentDays":
      return {
        kind: "recentDays",
        days: current.kind === "recentDays" ? current.days : SESSION_READ_DEFAULTS.recentDays,
      };
    case "absoluteRange":
      return current.kind === "absoluteRange" ? current : { kind: "absoluteRange", from: 0, to: 0 };
    default:
      return { kind: "reportPeriod" };
  }
}

export function sessionReadPeriodLabel(period: SessionReadPeriod): string {
  switch (period.kind) {
    case "reportPeriod":
      return "보고기간";
    case "recentDays":
      return `최근 ${period.days}일`;
    case "absoluteRange":
      return "직접 범위";
    case "relative":
      return relativeLabel(period.unit, period.count);
  }
}

function relativeLabel(unit: SessionReadRelativeUnit, count: number): string {
  // 표에 없는 단위는 문구를 비울 수 없으므로 첫 선택지로 읽는다.
  const choice = RELATIVE_CHOICE_BY_UNIT.get(unit) ?? RELATIVE_PERIOD_CHOICES[0];
  return count === 1 ? choice.label : `지난 ${count}${choice.pluralSuffix}`;
}

/** 저장 전에 상한을 맞춘다. 종류에 딸린 숫자가 있는 기간만 자를 것이 있다. */
export function clampSessionReadPeriod(period: SessionReadPeriod): SessionReadPeriod {
  switch (period.kind) {
    case "recentDays":
      return { kind: "recentDays", days: clampSessionReadCount(period.days, "recentDays") };
    case "relative":
      return {
        kind: "relative",
        unit: period.unit,
        count: clampSessionReadCount(period.count, "relativeCount"),
      };
    default:
      return period;
  }
}

/** 종류마다 딸린 값이 달라 그대로는 비교할 수 없으므로, 종류와 값을 한 줄로 편다. */
export function sessionReadPeriodKey(period: SessionReadPeriod): unknown[] {
  switch (period.kind) {
    case "relative":
      return [period.kind, period.unit, period.count];
    case "recentDays":
      return [period.kind, period.days];
    case "absoluteRange":
      return [period.kind, period.from, period.to];
    default:
      return [period.kind];
  }
}
