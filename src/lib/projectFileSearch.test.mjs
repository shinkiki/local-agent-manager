import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectFileSearchRequest, unreadContentCount } from "./projectFileSearch.ts";

const page = (over) => ({
  query: "q",
  entries: [],
  scanned: 0,
  truncated: false,
  gitStatusAvailable: true,
  searchedContents: false,
  excluded: 0,
  ...over,
});

test("본문 검색은 켠 요청에만 실리고 꺼진 요청은 그 칸 자체가 없다", () => {
  // 2026-10-04 실측: Core 의 search_contents(F3)·searched_contents·excluded 는 모두 서
  // 있었는데 ProjectFilesPanel 은 { projectPath, query } 만 보냈고 프런트 전체에
  // `searchContents` 라는 문자열이 한 번도 나오지 않았다. 기능이 사람에게 닿지 않는
  // 상태였고, 이 시험이 고정하는 것은 "켜면 실린다"와 "끄면 싣지 않는다" 둘이다.
  const off = buildProjectFileSearchRequest({ projectPath: "/w/a", query: "foo", searchContents: false });
  assert.deepEqual(off, { projectPath: "/w/a", query: "foo" });
  assert.equal("searchContents" in off, false);

  const on = buildProjectFileSearchRequest({ projectPath: "/w/a", query: "foo", searchContents: true });
  assert.equal(on.searchContents, true);
});

test("공백만 남는 질의는 요청을 만들지 않는다", () => {
  // Core 도 빈 질의를 거절하므로 보내 봤자 오류 배너 하나가 늘 뿐이다. 질의는 trim 한
  // 것이 실려야 한다 — 끝 공백이 그대로 가면 같은 검색이 캐시에서 서로 다른 질의가 된다.
  assert.equal(buildProjectFileSearchRequest({ projectPath: "/w/a", query: "   ", searchContents: true }), null);
  assert.equal(buildProjectFileSearchRequest({ projectPath: "/w/a", query: "", searchContents: false }), null);
  assert.equal(
    buildProjectFileSearchRequest({ projectPath: "/w/a", query: "  foo  ", searchContents: false }).query,
    "foo",
  );
});

test("열지 못한 파일 수는 본문 검색을 켜고 돈 결과에서만 알린다", () => {
  // excluded 는 제외 폴더·1MB 초과·바이너리라 "열지 않았다"는 뜻인데, 본문 검색을 끄고
  // 돌았으면 애초에 아무것도 열지 않은 것이라 그 수를 보여 주는 것이 거짓말이 된다.
  assert.equal(unreadContentCount(null), 0);
  assert.equal(unreadContentCount(page({ searchedContents: false, excluded: 12 })), 0);
  assert.equal(unreadContentCount(page({ searchedContents: true, excluded: 0 })), 0);
  assert.equal(unreadContentCount(page({ searchedContents: true, excluded: 12 })), 12);
});
