/**
 * `git status` 항목을 화면 네 묶음(스테이지됨·변경됨·추적 안 됨·충돌)으로 나누고 한 글자
 * 코드를 매긴다. 순수 함수만 두고 i18n 문구는 화면이 붙인다 — 이 모듈은 node 시험으로
 * 돈다.
 */
import type { GitChangeKind, GitStatusEntry } from "../types";

export type GitStatusSide = "index" | "worktree";

export interface GitStatusGroups {
  /** 인덱스에 변경이 있는 항목. 작업 트리에도 변경이 있으면 `unstaged`에도 든다. */
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicted: GitStatusEntry[];
}

const CHANGE_CODES: Record<GitChangeKind, string> = {
  unmodified: " ",
  modified: "M",
  typeChanged: "T",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  ignored: "!",
  unmerged: "U",
};

/** 변경 종류 하나의 porcelain 한 글자 코드. 커밋 파일 목록처럼 항목이 아니라 종류만 있을 때 쓴다. */
export function gitChangeKindCode(kind: GitChangeKind): string {
  return CHANGE_CODES[kind] ?? " ";
}

/** porcelain 한 글자 코드. 충돌 항목은 어느 쪽을 물어도 `U`다. */
export function gitChangeCode(entry: GitStatusEntry, side: GitStatusSide): string {
  if (isConflicted(entry)) return "U";
  const kind = side === "index" ? entry.indexStatus : entry.worktreeStatus;
  return CHANGE_CODES[kind] ?? " ";
}

export function isConflicted(entry: GitStatusEntry): boolean {
  return entry.unmerged !== null || entry.indexStatus === "unmerged" || entry.worktreeStatus === "unmerged";
}

export function isUntracked(entry: GitStatusEntry): boolean {
  return entry.worktreeStatus === "untracked" || entry.indexStatus === "untracked";
}

function hasChange(kind: GitChangeKind): boolean {
  return kind !== "unmodified" && kind !== "ignored";
}

/**
 * 충돌이 가장 먼저다 — 충돌 항목은 인덱스·작업 트리 코드가 둘 다 `U`라 다른 묶음으로도
 * 읽히지만 해결 전에는 스테이지 대상이 아니다. 추적 안 됨은 그 다음이고, 나머지는 인덱스와
 * 작업 트리를 따로 봐서 `MM`처럼 양쪽에 변경이 있는 항목은 두 묶음에 모두 선다.
 */
export function groupGitStatus(entries: GitStatusEntry[]): GitStatusGroups {
  const groups: GitStatusGroups = { staged: [], unstaged: [], untracked: [], conflicted: [] };
  for (const entry of entries) {
    if (isConflicted(entry)) {
      groups.conflicted.push(entry);
      continue;
    }
    if (isUntracked(entry)) {
      groups.untracked.push(entry);
      continue;
    }
    if (hasChange(entry.indexStatus)) groups.staged.push(entry);
    if (hasChange(entry.worktreeStatus)) groups.unstaged.push(entry);
  }
  return groups;
}

export type GitChangeLabelKey =
  | "modified"
  | "typeChanged"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "unmerged"
  | "unmodified";

/** 화면이 `text()`로 풀 안정된 키. 지금은 종류 이름과 같지만 화면이 종류에 직접 매달리지 않게 한 겹 둔다. */
export function gitChangeLabelKey(kind: GitChangeKind): GitChangeLabelKey {
  return kind;
}
