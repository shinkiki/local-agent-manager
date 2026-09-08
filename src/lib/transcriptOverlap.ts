/**
 * 세션 상세는 대화를 두 소스로 나눠 그린다. 위쪽은 서랍을 열 때 파일에서 읽은
 * 트랜스크립트 스냅샷이고, 아래쪽은 attach한 실행의 라이브 스트림이다.
 * attach는 백엔드가 버퍼에 남긴 과거 이벤트를 리플레이하므로, 이미 파일에 기록이
 * 끝난 턴은 두 소스에 모두 들어와 같은 응답이 두 번 보인다. 라이브가 담당하는
 * 첫 턴 시작 시각을 경계로 잡아 파일 쪽에서 그 구간을 잘라낸다.
 */

/** 라이브 스트림이 이미 보여 주는 구간의 시작 시각(epoch ms). 스트림이 비면 null. */
export function liveStreamBoundaryMs(turns: { startedAt: number }[]): number | null {
  let boundary: number | null = null;
  for (const turn of turns) {
    if (!Number.isFinite(turn.startedAt)) continue;
    if (boundary === null || turn.startedAt < boundary) boundary = turn.startedAt;
  }
  return boundary;
}

/**
 * 라이브 스트림이 담당하는 구간을 뺀 트랜스크립트. 경계가 없거나 겹치는 항목이
 * 없으면 원본 배열을 그대로 돌려준다. 시각이 없는 항목은 앞선 항목의 위치를
 * 따르므로, 경계를 넘긴 지점 이후는 시각 유무와 무관하게 잘라낸다.
 */
export function transcriptBeforeLiveStream<Item extends { timestamp: number | null }>(
  items: Item[],
  boundaryMs: number | null,
): Item[] {
  if (boundaryMs === null) return items;
  const cut = items.findIndex((item) => item.timestamp !== null && item.timestamp >= boundaryMs);
  return cut < 0 ? items : items.slice(0, cut);
}
