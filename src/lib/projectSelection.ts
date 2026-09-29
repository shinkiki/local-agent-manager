/**
 * 프로젝트 화면의 선택 박스가 어느 프로젝트를 고를지 정하는 규칙. 파일 탭과 형상관리 탭이
 * 같은 선택을 나눠 쓰고, 그 선택은 새로고침을 건너 복원된다(`agent-manager.projects-selected-path.v1`).
 *
 * 저장값은 화면이 닫힌 사이 바뀔 수 있다 — 프로젝트를 제외했거나 폴더가 사라졌으면 저장된
 * 경로가 활성 목록에 없다. 그때는 오류가 아니라 첫 활성 프로젝트로 떨어지고, 활성 프로젝트가
 * 하나도 없으면 고를 것이 없다(`null`). 화면은 그 `null`을 빈 상태 안내로 그린다.
 */
export function resolveSelectedProjectPath(
  active: readonly { path: string }[],
  stored: string | null,
): string | null {
  if (stored !== null && active.some((project) => project.path === stored)) return stored;
  return active[0]?.path ?? null;
}
