import type { GitCommit } from "../types";

/**
 * 현재 읽어 둔 커밋에서 사용자가 화면으로 확인할 수 있는 식별 정보를 검색한다.
 * 서버 검색처럼 보이지 않도록 호출부가 "불러온 N개" 범위를 함께 표시한다.
 */
export function filterGitCommits(commits: readonly GitCommit[], query: string): GitCommit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...commits];
  return commits.filter((commit) => [
    commit.sha,
    commit.shortSha,
    commit.subject,
    commit.body,
    commit.authorName,
    commit.authorEmail,
    commit.committerName,
    ...commit.refs,
  ].some((value) => value.toLocaleLowerCase().includes(needle)));
}
