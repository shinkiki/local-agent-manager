/**
 * 프로젝트 경로마다 하나씩 값을 두는 화면 설정 저장소(localStorage 한 키에 `{경로: 값}` 객체).
 *
 * 화면 설정이므로 읽기·쓰기 실패는 모두 삼킨다 — 저장소가 막혀 있거나 값이 깨져 있어도 화면은
 * 기본값으로 열리고, 이번 실행의 상태는 그대로 둔다.
 */

function readAll(key: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

/** `key` 아래 `projectPath`에 저장된 값. 저장소가 없거나 읽을 수 없으면 `undefined`. */
export function readProjectViewPref(key: string, projectPath: string): unknown {
  if (typeof window === "undefined") return undefined;
  try {
    return readAll(key)?.[projectPath];
  } catch {
    return undefined;
  }
}

/** `value`가 `undefined`면 그 프로젝트의 항목을 지운다. 다른 프로젝트의 항목은 그대로 둔다. */
export function writeProjectViewPref(key: string, projectPath: string, value: unknown): void {
  try {
    const all = { ...(readAll(key) ?? {}) };
    if (value === undefined) delete all[projectPath];
    else all[projectPath] = value;
    window.localStorage.setItem(key, JSON.stringify(all));
  } catch {
    // 저장소를 쓸 수 없어도 이번 실행의 상태는 그대로 둔다.
  }
}
