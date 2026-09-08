import type { QuietHours } from "../types";

/**
 * 페이싱 스케줄 — 페이싱을 멈출 시간대와 그 시간대를 적용할 요일. 회차의 소비 수치를
 * 다루는 `pacingSummary`와 붙어 있었지만 둘은 공유하는 값이 없다. 여기 있는 것은 저장된
 * 스케줄을 읽고 사람이 읽을 한 줄로 줄이는 규칙뿐이고, 그 규칙을 고칠 때 소진율 계산의
 * 경계 조건(참여 계정·회당 소비)을 함께 읽을 필요가 없도록 파일을 나눠 둔다.
 */

type Text = (ko: string, en: string) => string;
const identity: Text = (ko) => ko;

/**
 * 요일 정본 표. 인덱스가 그대로 요일 번호(0=일…6=토)이고, 한 줄이 그 요일의 한글·영문
 * 이름을 함께 들고 있다.
 *
 * "요일은 일곱 개이고 이렇게 불린다"는 사실이 이 파일 안에서 네 자리에 흩어져 있었다 —
 * 한글 이름 배열, 영문 이름 배열, 전체 요일 번호 목록, 그리고 "매일"을 판정하는 숫자 7.
 * 두 이름 배열은 서로 같은 자리에 같은 요일이 있어야만 맞는데 그 짝은 어디에도 적혀 있지
 * 않았고, 나머지 둘은 개수를 손으로 다시 적은 것이다. 한 줄이 한 요일을 통째로 들고 있으면
 * 한글만 고쳐 영문이 어긋나거나, 목록만 늘려 "매일"이 영원히 뜨지 않는 일이 생기지 않는다.
 */
const WEEKDAYS: readonly { ko: string; en: string }[] = [
  { ko: "일", en: "Sun" },
  { ko: "월", en: "Mon" },
  { ko: "화", en: "Tue" },
  { ko: "수", en: "Wed" },
  { ko: "목", en: "Thu" },
  { ko: "금", en: "Fri" },
  { ko: "토", en: "Sat" },
];

/**
 * 요일 번호의 표시 순서. 화면은 월요일부터 보여 준다. 이름과 달리 표시 순서는 요일 번호에서
 * 나오지 않는 별개의 사실이라 표에서 뽑지 않고 여기서 따로 적는다.
 */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAY_NAMES: readonly string[] = WEEKDAYS.map((weekday) => weekday.ko);
export const WEEKDAY_NAMES_EN: readonly string[] = WEEKDAYS.map((weekday) => weekday.en);

/** 전체 요일 번호를 번호순으로. 저장값이 없을 때의 "매일"이 이 목록 그대로 나간다. */
const ALL_WEEKDAYS: readonly number[] = WEEKDAYS.map((_, day) => day);

/** 저장된 스케줄이 없을 때의 초안: 꺼진 채 평일 09:00~18:00(근무 시간을 막는 흔한 예). */
export function defaultQuietHours(timezone: string): QuietHours {
  return { enabled: false, start: "09:00", end: "18:00", timezone, weekdays: [1, 2, 3, 4, 5] };
}

/** 구형 백엔드 응답에는 weekdays가 없을 수 있다. 그때는 매일로 읽는다. */
export function quietWeekdays(hours: Pick<QuietHours, "weekdays"> | null | undefined): number[] {
  const days = hours?.weekdays;
  return days && days.length > 0 ? [...days] : [...ALL_WEEKDAYS];
}

/** 요일 집합을 월~일 순서로 요약: 전부면 "매일", 연속 구간이면 "월~금", 그 밖은 "월·수·금". */
export function describeWeekdays(weekdays: readonly number[], text: Text = identity): string {
  // 표시 순서를 한 번만 훑고 그 자리(position)를 함께 들고 나온다. 연속 구간 판정이 자리를
  // indexOf로 다시 찾지 않아, 순서 표를 두 번 읽으며 어긋날 자리가 없다.
  const checked = WEEKDAY_ORDER
    .map((day, position) => ({ day, position }))
    .filter((entry) => weekdays.includes(entry.day));
  if (checked.length === WEEKDAYS.length) return text("매일", "every day");
  const name = (entry: { day: number }) => text(WEEKDAY_NAMES[entry.day], WEEKDAY_NAMES_EN[entry.day]);
  const contiguous = checked.length >= 3
    && checked.every((entry, index) => index === 0 || entry.position === checked[index - 1].position + 1);
  if (contiguous) return `${name(checked[0])}~${name(checked[checked.length - 1])}`;
  return checked.map(name).join("·");
}

/** 스케줄 요약 한 줄. 꺼져 있거나 없으면 null. 예: "제한 09:00~18:00 · 월~금". */
export function describeQuietHours(hours: QuietHours | null | undefined, text: Text = identity): string | null {
  if (!hours?.enabled) return null;
  const days = describeWeekdays(quietWeekdays(hours), text);
  return text(`제한 ${hours.start}~${hours.end} · ${days}`, `Quiet ${hours.start}~${hours.end} · ${days}`);
}
