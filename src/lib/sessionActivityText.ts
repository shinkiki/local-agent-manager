/**
 * 최근 세션 배지가 쓰는 시간 문구. 지금 이 세션이 어떤 상태인가를 가르는 판정
 * (`sessionActivity.ts`)과 한 파일에 있던 동안에는, "2시간 5분째"의 단위 표기 한 줄을
 * 손보러 들어와도 알림 종류와 중단·실패를 가르는 규칙까지 함께 스크롤해야 했고 그 반대도
 * 마찬가지였다. 둘은 서로를 부르지 않고 바뀌는 이유도 다르다 — 한쪽은 알림 종류가 늘 때,
 * 다른 한쪽은 문구를 다듬을 때 바뀐다.
 */

/** 주 단위와 나머지 보조 단위를 결합해 'N단위째' 또는 'N단위 M보조단위째' 문구를 만든다. */
function formatCompoundElapsed(
  majorValue: number,
  majorUnit: string,
  minorValue: number,
  minorUnit: string,
): string {
  return minorValue === 0
    ? `${majorValue}${majorUnit}째`
    : `${majorValue}${majorUnit} ${minorValue}${minorUnit}째`;
}

/** 진행 중 배지에 표시할 경과 시간. 초 단위 흔들림 없이 분 단위로 갱신한다. */
export function formatRunningElapsed(startedAt: number | null, nowMs: number): string {
  if (startedAt === null || !Number.isFinite(startedAt)) return "시간 확인 중";
  const minutes = Math.floor(Math.max(0, nowMs - startedAt) / 60_000);
  if (minutes < 1) return "1분 미만";
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return formatCompoundElapsed(hours, "시간", minutes % 60, "분");
  const days = Math.floor(hours / 24);
  return formatCompoundElapsed(days, "일", hours % 24, "시간");
}
