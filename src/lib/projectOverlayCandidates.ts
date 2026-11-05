import type { GitStatus } from "../types";

/** C19-3. Overlay 후보 표시는 충돌·서브모듈을 뺀 작업 트리 수정만 담는다. */
export function projectOverlayCandidates(status: Pick<GitStatus, "entries"> | null): string[] {
  return status === null
    ? []
    : status.entries
      .filter((entry) => entry.worktreeStatus === "modified" && entry.unmerged === null && !entry.isSubmodule)
      .map((entry) => entry.path);
}
