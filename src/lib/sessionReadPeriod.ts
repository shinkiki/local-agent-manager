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
  { value: "lastDay", unit: "day", label: "어제", pluralSuffix: "일", days: 1 },
  { value: "lastWeek", unit: "week", label: "지난주", pluralSuffix: "주", days: 7 },
  { value: "lastMonth", unit: "month", label: "지난달", pluralSuffix: "개월", days: 30 },
] as const satisfies readonly {
  value: string;
  unit: SessionReadRelativeUnit;
  label: string;
  pluralSuffix: string;
  /** 한 단위를 최근 N일로 옮길 때의 일수. 단위를 하나 더하면 이 값도 함께 정해야 한다. */
  days: number;
}[];

type RelativePeriodChoice = (typeof RELATIVE_PERIOD_CHOICES)[number];

/**
 * 표를 단위로 찾는 색인. 정책이 들고 있는 값은 단위라, 선택지 값과 표시 문구를 묻는 두
 * 자리가 모두 이 열로 표를 읽는다. 둘이 각자 `find`를 적던 동안에는 같은 표를 어떤 열로
 * 읽는지가 호출부마다 흩어져 있었고 두 폴백이 서로 달라도 나란히 놓고 볼 수 없었다.
 * 조회는 여기로 모으고, 무엇으로 되돌릴지는 그 답이 필요한 호출부가 정한다.
 *
 * 반대 방향(선택지 값 → 표 항목)은 색인으로 두지 않는다. 그 방향을 묻던 유일한 자리인
 * 선택지 되돌리기가 이제 선택지 전수 표([`CHOICE_PERIOD_RULES`])를 직접 읽기 때문이다 —
 * 조회로 두면 표에 없는 값이 폴백으로 흘러들 자리가 다시 생긴다.
 */
const RELATIVE_CHOICE_BY_UNIT: ReadonlyMap<SessionReadRelativeUnit, RelativePeriodChoice> =
  new Map(RELATIVE_PERIOD_CHOICES.map((choice) => [choice.unit, choice] as const));

type SessionReadPeriodChoice =
  | "reportPeriod"
  | "recentDays"
  | "absoluteRange"
  | RelativePeriodChoice["value"];

/**
 * 기간 종류마다 무엇을 할지 적는 표. 종류를 모두 요구하므로, `SessionReadPeriod`에 종류가
 * 하나 늘면 이 표를 쓰는 자리가 모두 컴파일에서 멈춘다.
 *
 * 종류별 규칙을 `switch`에 `default:`를 달아 적던 동안에는 새 종류가 그 폴백으로 조용히
 * 흘러들었다 — 저장 전 자르기는 새 종류의 숫자를 자르지 않고 그대로 통과시키고, 비교 열쇠는
 * 종류 이름만 적어 딸린 값이 달라도 같은 정책으로 판정한다. 둘 다 화면에는 아무 표시가
 * 남지 않아서, 새 종류를 더한 사람이 여기까지 찾아와야만 드러났다.
 */
type PeriodKindRules<T> = {
  [Kind in SessionReadPeriod["kind"]]: (period: Extract<SessionReadPeriod, { kind: Kind }>) => T;
};

/**
 * 기간 하나를 그 종류의 규칙에 넘긴다. 표의 키와 넘기는 값의 종류가 같다는 것은 조회
 * 식만으로는 좁혀지지 않으므로, 그 한 걸음만 여기서 단언하고 호출부는 좁혀진 값을 받는다.
 */
function byPeriodKind<T>(period: SessionReadPeriod, rules: PeriodKindRules<T>): T {
  return (rules[period.kind] as (value: SessionReadPeriod) => T)(period);
}

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
  return byPeriodKind<SessionReadPeriodChoice>(period, {
    reportPeriod: () => "reportPeriod",
    recentDays: () => "recentDays",
    absoluteRange: () => "absoluteRange",
    relative: ({ unit, count }) => {
      // 한 단위만 선택지로 두므로, 2주처럼 표에 없는 값은 숫자를 직접 적는 쪽으로 보낸다.
      if (count !== 1) return "recentDays";
      // 선택지에 없는 단위는 표시할 항목이 없으므로 숫자를 직접 적는 쪽으로 보낸다.
      return RELATIVE_CHOICE_BY_UNIT.get(unit)?.value ?? "recentDays";
    },
  });
}

/**
 * 선택지 하나를 골랐을 때 무엇으로 되돌릴지. 기존 값이 같은 종류면 딸린 숫자를 물려받으므로
 * 현재 정책을 함께 받는다.
 */
type ChoicePeriodRules = {
  [Choice in SessionReadPeriodChoice]: (current: SessionReadPeriod) => SessionReadPeriod;
};

/**
 * 표에서 세우는 상대 기간 선택지의 규칙. 선택지 값·단위 대응은 `RELATIVE_PERIOD_CHOICES`
 * 한 곳에만 있어야 하므로 전체 표에 손으로 옮겨 적지 않고 여기서 펴서 얹는다. 표에 단위를
 * 하나 더하면 선택지 값 union이 함께 늘어 이 반환형도 그만큼 넓어진다.
 */
function relativeChoiceRules(): { [Choice in RelativePeriodChoice["value"]]: () => SessionReadPeriod } {
  const entries = RELATIVE_PERIOD_CHOICES.map((choice) => [
    choice.value,
    (): SessionReadPeriod => (
      { kind: "relative", unit: choice.unit, count: SESSION_READ_DEFAULTS.relativeCount }
    ),
  ]);
  // 표를 편 결과가 표의 값을 모두 덮는다는 것은 `Object.fromEntries`의 반환형으로는
  // 좁혀지지 않는다. 그 한 걸음만 여기서 단언하고, 표를 쓰는 쪽은 전수 검사를 받는다.
  return Object.fromEntries(entries) as { [Choice in RelativePeriodChoice["value"]]: () => SessionReadPeriod };
}

/**
 * 선택지마다 무엇으로 되돌릴지 적는 표. 선택지를 모두 요구하므로, `SessionReadPeriodChoice`에
 * 값이 하나 늘면 여기서 컴파일이 멈춘다.
 *
 * 기간 종류 쪽([`PeriodKindRules`])과 달리 이 방향만 `switch`에 `default:`를 달아 적고
 * 있었다. 그 폴백은 "아직 규칙을 정하지 않은 선택지"와 "보고기간"을 같은 갈래로 삼켜,
 * 선택지를 하나 더한 사람이 여기까지 찾아오지 않으면 새 선택지를 고른 화면이 조용히
 * 보고기간으로 되돌아간다 — 고른 값과 다른 값이 저장되는데 화면에는 아무 표시가 남지 않는다.
 */
const CHOICE_PERIOD_RULES: ChoicePeriodRules = {
  reportPeriod: () => ({ kind: "reportPeriod" }),
  recentDays: (current) => ({
    kind: "recentDays",
    days: current.kind === "recentDays" ? current.days : SESSION_READ_DEFAULTS.recentDays,
  }),
  absoluteRange: (current) => (
    current.kind === "absoluteRange" ? current : { kind: "absoluteRange", from: 0, to: 0 }
  ),
  ...relativeChoiceRules(),
};

/** 선택지를 실제 정책 값으로 바꾼다. 기존 값이 있으면 같은 종류의 숫자를 물려받는다. */
export function sessionReadPeriodFromChoice(
  choice: SessionReadPeriodChoice,
  current: SessionReadPeriod,
): SessionReadPeriod {
  return CHOICE_PERIOD_RULES[choice](current);
}

/**
 * "최근 N일" 선택지와 함께 서는 일수 입력이 무엇을 세울지. 그 선택지가 아니면 null이다.
 *
 * 편집기는 선택지를 [`sessionReadPeriodChoice`]로 고르면서 곁들인 숫자 칸만 기간 **종류**로
 * 갈랐다. 둘은 같은 답을 주지 않는다 — `{relative, week, 3}`은 표에 없는 값이라 선택지가
 * "최근 N일"로 접히는데(위 주석) 종류는 그대로 `relative`라, 화면에는 "최근 N일"만 뜨고
 * 숫자 칸이 서지 않았다. 저장된 3주를 보지도 고치지도 못하고, 다른 선택지를 골랐다가
 * 돌아오면 조용히 기본값으로 떨어진다. 곁들인 칸을 세울지는 선택지가 정할 일이므로
 * 판정을 선택지 쪽에 두고, 값은 표의 일수 환산으로 옮긴다.
 */
export interface SessionReadRecentDaysField {
  /**
   * 칸에 세울 일수. 저장 가능한 상한(`SESSION_READ_LIMITS.recentDays`)을 넘지 않는다 —
   * 칸은 `max`가 걸린 입력이라, 상한을 넘는 값을 세우면 브라우저가 폼 전체를 못 내보내게
   * 막는다. 이 칸은 접힌 고급 옵션 안에 있어 초점조차 갈 수 없고, 그러면 사용자는 저장
   * 버튼이 아무 반응도 하지 않는 화면을 보게 된다.
   */
  days: number;
  /**
   * 접기 전 환산 일수. `days`와 다르면 칸이 **저장된 기간보다 짧게** 보인다.
   *
   * 상대 기간은 최대 24개월(약 720일)까지 저장되는데 "최근 N일"은 365일까지만 담는다.
   * 환산값을 조용히 자르던 동안에는 저장된 18개월이 "최근 365일"로 떠, 화면이 실제로
   * 집행되는 참조 창의 절반만 적었다 — 값을 고치지 않고 나가면 정책은 그대로 18개월이다.
   * 칸은 저장 가능한 값으로 세우되, 잘렸다는 사실은 이 값으로 알린다.
   */
  foldedFromDays: number;
}

export function sessionReadRecentDaysField(
  period: SessionReadPeriod,
): SessionReadRecentDaysField | null {
  if (sessionReadPeriodChoice(period) !== "recentDays") return null;
  const foldedFromDays = byPeriodKind<number | null>(period, {
    recentDays: ({ days }) => days,
    relative: ({ unit, count }) => (
      count * (RELATIVE_CHOICE_BY_UNIT.get(unit) ?? RELATIVE_PERIOD_CHOICES[0]).days
    ),
    // 제 선택지를 가진 종류는 위 판정에서 이미 걸러진다. 표가 종류를 모두 요구하므로 남긴다.
    reportPeriod: () => null,
    absoluteRange: () => null,
  });
  if (foldedFromDays === null) return null;
  return { days: clampSessionReadCount(foldedFromDays, "recentDays"), foldedFromDays };
}

export function sessionReadPeriodLabel(period: SessionReadPeriod): string {
  return byPeriodKind<string>(period, {
    reportPeriod: () => "보고기간",
    recentDays: ({ days }) => `최근 ${days}일`,
    absoluteRange: () => "직접 범위",
    relative: ({ unit, count }) => relativeLabel(unit, count),
  });
}

/**
 * 직접 범위의 시작이 끝보다 늦은지. 서버는 이것을 저장 시점에 거절하므로
 * (`session_context.rs` `normalize_period`), 화면도 같은 판정으로 입력 시점에 알린다.
 * 두 칸을 모두 비운 처음 상태(0·0)는 역전이 아니다 — 서버도 `from > to`만 본다. 한쪽만
 * 채우면 반대쪽이 0이라 역전이 되는데, 이는 서버가 실제로 거절하는 값이라 그대로 알린다.
 */
export function sessionReadPeriodInverted(period: SessionReadPeriod): boolean {
  return period.kind === "absoluteRange" && period.from > period.to;
}

/** 역전을 알리는 문장. 판정과 갈라지지 않도록 [`sessionReadPeriodInverted`]와 한자리에 둔다. */
export const SESSION_READ_PERIOD_INVERTED_TEXT =
  "세션 참조 기간의 종료일은 시작일보다 뒤여야 합니다.";

function relativeLabel(unit: SessionReadRelativeUnit, count: number): string {
  // 표에 없는 단위는 문구를 비울 수 없으므로 첫 선택지로 읽는다.
  const choice = RELATIVE_CHOICE_BY_UNIT.get(unit) ?? RELATIVE_PERIOD_CHOICES[0];
  return count === 1 ? choice.label : `지난 ${count}${choice.pluralSuffix}`;
}

/** 저장 전에 상한을 맞춘다. 종류에 딸린 숫자가 있는 기간만 자를 것이 있다. */
export function clampSessionReadPeriod(period: SessionReadPeriod): SessionReadPeriod {
  return byPeriodKind<SessionReadPeriod>(period, {
    // 자를 숫자가 없는 종류는 받은 값을 그대로 돌려줘 참조가 유지된다.
    reportPeriod: (value) => value,
    absoluteRange: (value) => value,
    recentDays: ({ days }) => (
      { kind: "recentDays", days: clampSessionReadCount(days, "recentDays") }
    ),
    relative: ({ unit, count }) => (
      { kind: "relative", unit, count: clampSessionReadCount(count, "relativeCount") }
    ),
  });
}

/** 종류마다 딸린 값이 달라 그대로는 비교할 수 없으므로, 종류와 값을 한 줄로 편다. */
export function sessionReadPeriodKey(period: SessionReadPeriod): unknown[] {
  return byPeriodKind<unknown[]>(period, {
    reportPeriod: ({ kind }) => [kind],
    relative: ({ kind, unit, count }) => [kind, unit, count],
    recentDays: ({ kind, days }) => [kind, days],
    absoluteRange: ({ kind, from, to }) => [kind, from, to],
  });
}
