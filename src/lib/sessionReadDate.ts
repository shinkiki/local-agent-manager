/** `type=date` 입력값 변환. 날짜만 다루므로 로컬 자정 기준으로 왕복한다. */
export function dateInputValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 로컬 날짜 문자열(YYYY-MM-DD)을 해당 일자의 시작(00:00:00) 또는 끝(23:59:59.999) 시각(ms)으로 변환 */
export function dayBoundaryMs(value: string, boundary: "start" | "end"): number {
  if (!value) return 0;
  const [year, month, day] = value.split("-").map(Number);
  const [hour, minute, second, ms] = boundary === "start" ? [0, 0, 0, 0] : [23, 59, 59, 999];
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
}
