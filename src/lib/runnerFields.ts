/**
 * 실행기 편집기의 숫자 칸(동시 자리 수·브라우저 자리 수)이 함께 쓰는 판정.
 *
 * 둘 다 `type="number"` 칸이지만 브라우저는 `1e1`·`3.5` 같은 값을 그대로 넘긴다. `parseInt` 로
 * 받으면 `1e1`(=10)은 1, `3.5` 는 3 으로 저장돼 사용자가 본 값과 저장된 값이 달라진다.
 * 그래서 공백을 뺀 자리 전체가 숫자일 때만 값으로 받고, 그 밖에는 null 이다.
 */
export function parseWholeNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `parseWholeNumber` 가 받은 값이 `[min, max]` 안에 있는지. 값이 아니면 false 다. */
export function wholeNumberWithin(value: string, min: number, max: number): boolean {
  const parsed = parseWholeNumber(value);
  return parsed !== null && parsed >= min && parsed <= max;
}

/** 실행기 프로젝트 이름의 길이 상한(C21-2, runners.rs `MAX_TOKEN_CHARS`). */
const MAX_PROJECT_NAME_CHARS = 64;

/**
 * 백엔드가 저장한 정규 경로와 프로젝트 목록의 경로를 견줄 때의 열쇠. Windows 확장 경로 접두와
 * 끝 구분자를 걷는다(인덱스 애드온 `indexPathKey`와 같은 규칙). 둘 다 정규 경로라 그 밖은 같다.
 */
export function runnerPathKey(path: string): string {
  return path.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
}

/** 한 글을 실행기 프로젝트 이름 모양(`[a-z0-9._-]`)으로 접는다. 남는 것이 없거나 `.`·`..`이면 빈 글이다. */
function foldProjectName(value: string): string {
  const folded = value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PROJECT_NAME_CHARS)
    .replace(/-+$/, "");
  return folded === "." || folded === ".." ? "" : folded;
}

/**
 * 프로젝트 목록에서 고른 프로젝트에 붙일 실행기 프로젝트 이름. 외부 도구가 원격 작업 폴더 이름으로
 * 쓰므로 `[a-z0-9._-]{1,64}`여야 하고 다른 줄과 겹치면 안 된다(C21-2). 프로젝트 이름을 접어 쓰고,
 * 한글 이름처럼 남는 것이 없으면 폴더 이름, 그것도 없으면 `project`로 한다. 겹치면 `-2`, `-3`…을 붙인다.
 */
export function runnerProjectName(name: string, path: string, taken: readonly string[]): string {
  const folder = runnerPathKey(path).split(/[\\/]/).pop() ?? "";
  const base = foldProjectName(name) || foldProjectName(folder) || "project";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, MAX_PROJECT_NAME_CHARS - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
