import type { ProjectFileSearchPage, ProjectFileSearchRequest } from "../types";

/**
 * 프로젝트 파일 검색의 질의 조립과 결과 해석(F3·F6).
 *
 * 2026-10-04 실측: Core 는 `search_contents` 를 받아 본문까지 훑고(F3) 결과에
 * `searched_contents` 와 열지 못한 파일 수 `excluded` 를 실어 보내는데, **화면에는 그
 * 스위치가 없었다.** `ProjectFilesPanel` 은 `{ projectPath, query }` 만 보냈고 `searchContents`
 * 라는 문자열은 프런트 어디에도 나오지 않았다 — 타입과 Core 와 IPC 래퍼까지 다 서 있는
 * 기능이 사람에게는 닿지 않는 상태였다. 켜는 자리와 읽는 자리를 여기로 모아 둔 것은
 * 컴포넌트 안에서는 시험할 수 없기 때문이다.
 *
 * 조립이 지키는 것 둘:
 * - 꺼져 있으면 `searchContents` 를 **아예 싣지 않는다**. `false` 를 명시로 보내도 Core 의
 *   기본값과 같지만, 보내지 않는 쪽이 "이 화면은 기본이 파일명 검색"이라는 계약을 요청
 *   자체로 말한다.
 * - 공백만 남는 질의는 요청을 만들지 않는다(`null`). Core 도 빈 질의를 거절하므로, 보내 봤자
 *   오류 배너 하나가 늘 뿐이다.
 */
export function buildProjectFileSearchRequest(input: {
  projectPath: string;
  query: string;
  searchContents: boolean;
}): ProjectFileSearchRequest | null {
  const query = input.query.trim();
  if (query.length === 0) return null;
  const request: ProjectFileSearchRequest = { projectPath: input.projectPath, query };
  if (input.searchContents) request.searchContents = true;
  return request;
}

/** 결과가 말하지 않은 것을 사람에게 알려야 하는지. 본문 검색을 켰는데 열지 못한 파일이 있을 때다. */
export function unreadContentCount(page: ProjectFileSearchPage | null): number {
  if (!page) return 0;
  // `searchedContents` 를 같이 보는 이유: 본문 검색을 끄고 돈 결과에도 Core 가 `excluded` 를
  // 0 이 아닌 값으로 실을 수 있고, 그때의 "열지 않았다"는 사용자가 알 필요가 없는 사실이다.
  if (!page.searchedContents) return 0;
  return page.excluded > 0 ? page.excluded : 0;
}
