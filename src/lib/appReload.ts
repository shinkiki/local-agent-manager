/**
 * 재배포로 사라진 해시 자산을 옛 앱 셸이 요청했을 때의 복구 판단.
 *
 * 원격 웹은 서비스워커가 앱 셸(`/`)을 캐시한다. 백엔드 재기동 중에 탐색이 실패하면
 * `networkFirstNavigation`이 캐시된 옛 셸을 돌려주고, 그 셸이 참조하는 메인 청크는
 * 캐시에서 나오므로 앱은 정상으로 보인다. 아직 캐시에 없던 lazy 청크를 처음 요청하는
 * 순간에야 404가 나고, 잡는 곳이 없으면 화면 전체가 빈다. 그래서 청크 적재 실패는
 * 렌더 오류가 아니라 "셸이 낡았다"는 신호로 다루고 새로 받아 온다.
 */

/** 동적 import 실패 문구는 브라우저마다 달라 부분 일치로 판정한다. */
const STALE_CHUNK_MESSAGES = [
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "failed to load module script",
  "expected a javascript module script",
  "unable to preload css",
];

export function isStaleChunkError(cause: unknown): boolean {
  const raw = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause ?? "");
  const message = raw.toLowerCase();
  return STALE_CHUNK_MESSAGES.some((candidate) => message.includes(candidate));
}

/** 서비스워커가 자산 404를 만났을 때 창으로 보내는 알림. `public/sw.js`와 같은 값이어야 한다. */
export const STALE_SHELL_MESSAGE = "agent-manager.stale-shell";

export const STALE_SHELL_RELOAD_KEY = "agent-manager.stale-shell-reload";
/** 이 시간 안에 이미 셸 때문에 새로고침했다면 다시 하지 않는다. */
export const STALE_SHELL_RELOAD_WINDOW_MS = 60_000;

type ReloadStore = Pick<Storage, "getItem" | "setItem"> | null;

/**
 * 새로고침해도 자산이 여전히 없으면 같은 404가 다시 나므로, 가드 없이는 무한 새로고침이
 * 된다. 세션 저장소에 마지막 시도 시각을 남겨 창 안에서 한 번만 허용한다.
 */
export function shouldReloadForStaleShell(store: ReloadStore, now: number): boolean {
  if (!store) return false;
  let previous: string | null = null;
  try {
    previous = store.getItem(STALE_SHELL_RELOAD_KEY);
  } catch {
    // 저장소를 못 읽으면 반복 여부를 알 수 없다. 새로고침을 포기하고 오류 화면을 남긴다.
    return false;
  }
  const last = previous === null ? Number.NaN : Number(previous);
  if (Number.isFinite(last) && now - last < STALE_SHELL_RELOAD_WINDOW_MS) return false;
  try {
    store.setItem(STALE_SHELL_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  return true;
}

function sessionStoreOrNull(): ReloadStore {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** 가드를 통과하면 실제로 새로고침한다. 반환값은 새로고침을 시작했는지 여부. */
export function reloadForStaleShell(): boolean {
  if (typeof window === "undefined") return false;
  if (!shouldReloadForStaleShell(sessionStoreOrNull(), Date.now())) return false;
  window.location.reload();
  return true;
}
