import type { ProviderId } from "../types";
import { dedupeByKey } from "./sequence.ts";
import { sessionKey } from "./sessionKey.ts";

/**
 * 세션 하나를 색인하기 위한 재시도 지연(ms).
 *
 * 색인은 공급자 CLI가 기록을 남긴 뒤에야 가능하므로 짧게 여러 번 다시 본다. 다만
 * 목록에 절대 나타나지 않는 세션도 있다(실행이 기록을 남기지 못한 경우). 그래서 예산은
 * 유한해야 한다. 예전에는 상한이 없어, 존재하지 않는 완료 실행 하나가 폴링마다 갱신
 * 요청을 무한히 만들어 백엔드 대기 스레드를 쌓았다.
 */
export const SESSION_SYNC_DELAYS_MS: readonly number[] = [0, 200, 600, 1_200, 2_400];

interface SessionSyncTarget {
  source: ProviderId;
  id: string;
}

/**
 * 포기 목록에 넣을 키. 형식은 `sessionKey`가 정한다 — 이름만 색인 쪽 호출부를 위해 남긴다.
 */
export { sessionKey as sessionSyncKey };

interface CompletedRunRef {
  scheduleId: string;
  providerSessionId: string | null;
}

/**
 * 완료 실행 한 건이 아직 색인해야 하는 대상이면 그 대상을 만든다. 제외 대상(알 수 없는
 * 공급자, 빈 세션 ID, 이미 색인됨, 포기됨)이면 null이다.
 *
 * 키를 함께 실어 내보내지 않는다 — 키는 대상에서 온전히 정해지므로, 중복을 걷어내는 쪽이
 * 같은 규칙으로 다시 만들면 된다. 키를 나르던 동안에는 이 함수의 반환이 [키, 대상] 짝이라
 * 대상을 모으는 쪽이 자리마다 짝을 풀어야 했고, 중복 제거가 무슨 열쇠를 보는지가 여기와
 * 그쪽 두 곳에 나뉘어 있었다.
 */
function pendingSyncTarget(
  run: CompletedRunRef,
  sourceByScheduleId: ReadonlyMap<string, ProviderId>,
  isIndexed: (source: ProviderId, id: string) => boolean,
  abandoned: ReadonlySet<string>,
): SessionSyncTarget | null {
  const id = run.providerSessionId;
  const source = sourceByScheduleId.get(run.scheduleId);
  if (!id || !source) return null;
  if (abandoned.has(sessionKey(source, id)) || isIndexed(source, id)) return null;
  return { source, id };
}

/**
 * 아직 목록에 없는 완료 실행의 색인 대상. 이미 포기한 대상은 제외한다.
 *
 * 제외가 없으면 색인될 수 없는 실행 하나가 폴링 주기마다 같은 요청을 영구히 만든다.
 */
export function unindexedRunTargets(
  runs: readonly CompletedRunRef[],
  sourceByScheduleId: ReadonlyMap<string, ProviderId>,
  isIndexed: (source: ProviderId, id: string) => boolean,
  abandoned: ReadonlySet<string>,
): SessionSyncTarget[] {
  const targets = runs.flatMap((run) => (
    pendingSyncTarget(run, sourceByScheduleId, isIndexed, abandoned) ?? []
  ));
  // 열쇠가 같으면 대상도 같은 값이므로 어느 쪽을 남길지 고를 것이 없다.
  return dedupeByKey(targets, (target) => sessionKey(target.source, target.id));
}

/**
 * 알림에서 화면을 열 때 색인 동기화를 기다려 주는 유예(ms).
 *
 * 색인 예산(`SESSION_SYNC_DELAYS_MS`)을 끝까지 기다리면 최악의 경우 4초 넘게 화면이 그대로라
 * 클릭이 먹지 않은 것처럼 보인다. 첫 시도가 끝날 만큼만 기다리고, 그 안에 색인되지 않으면
 * 다른 경로로 화면을 먼저 연다.
 */
export const SESSION_SYNC_GRACE_MS = 300;

/**
 * `task`가 끝나거나 `graceMs`가 지나면 반환한다. 유예를 넘겨 접은 뒤에도 `task`는 배경에서
 * 계속 돌아 색인을 마친다. 실패도 "더 기다릴 이유가 없다"는 뜻이므로 같게 다룬다.
 */
export function waitWithSyncGrace(
  task: Promise<unknown>,
  graceMs: number = SESSION_SYNC_GRACE_MS,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    const settle = () => { clearTimeout(timer); resolve(); };
    void task.then(settle, settle);
  });
}
