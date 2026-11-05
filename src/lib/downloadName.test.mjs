import assert from "node:assert/strict";
import test from "node:test";
import { linkedFileName, responseFileName, sanitizeDownloadName } from "./downloadName.ts";

test("이름 다듬기는 경로 구분자와 NUL을 바꾸고 빈 이름은 download로 떨어뜨린다", () => {
  assert.equal(sanitizeDownloadName("a/b\\c\0d.txt"), "a_b_c_d.txt");
  assert.equal(sanitizeDownloadName("  report.pdf  "), "report.pdf");
  assert.equal(sanitizeDownloadName(""), "download");
  assert.equal(sanitizeDownloadName("   "), "download");
  assert.equal(sanitizeDownloadName("."), "download");
  assert.equal(sanitizeDownloadName(".."), "download");
  // 두 조각이 구분자로 이어진 상대 경로는 한 이름으로 접힌다 — 디렉터리로 올라가지 않는다.
  assert.equal(sanitizeDownloadName("../../etc/passwd"), ".._.._etc_passwd");
});

test("링크 이름은 마지막 경로 조각에서 질의·조각·줄 번호를 걷어낸다", () => {
  assert.equal(linkedFileName("docs/plan.md"), "plan.md");
  assert.equal(linkedFileName("https://host/dir/report.pdf?dl=1#page=2"), "report.pdf");
  assert.equal(linkedFileName("<src/lib/chat.ts:120>"), "chat.ts");
  assert.equal(linkedFileName("C:\\Users\\me\\memo.txt"), "memo.txt");
  assert.equal(linkedFileName("  ./notes.md  "), "notes.md");
});

test("링크 이름은 퍼센트 부호를 풀고, 풀 수 없으면 원문을 쓴다", () => {
  assert.equal(linkedFileName("docs/%ED%9A%8C%EC%9D%98.md"), "회의.md");
  // 풀고 나서 생긴 구분자는 이름을 가르지 않고 걷어낸다 — 푼 뒤 `/`가 생겨도 위로 올라가지 않는다.
  assert.equal(linkedFileName("a%2F..%2Fb.txt"), "b.txt");
  assert.equal(linkedFileName("bad%E0%A4%A.txt"), "bad%E0%A4%A.txt");
});

test("링크에 이름이 남지 않으면 download다", () => {
  // 호스트만 있는 주소는 마지막 조각이 호스트라 그 이름이 된다 — 빈 이름이 아니다.
  assert.equal(linkedFileName("https://host/"), "host");
  assert.equal(linkedFileName(""), "download");
  assert.equal(linkedFileName("?x=1"), "download");
});

test("응답 헤더 이름은 UTF-8 꼴을 먼저 보고 따옴표 꼴로 내려간다", () => {
  assert.equal(responseFileName(null), null);
  assert.equal(responseFileName("inline"), null);
  assert.equal(
    responseFileName("attachment; filename=\"fallback.txt\"; filename*=UTF-8''%ED%9A%8C%EC%9D%98.txt"),
    "회의.txt",
  );
  assert.equal(responseFileName("attachment; filename=\"plain name.txt\""), "plain name.txt");
  // UTF-8 꼴이 깨져 있으면 따옴표 꼴이 받는다.
  assert.equal(responseFileName("attachment; filename*=UTF-8''%E0%A4%A; filename=\"safe.txt\""), "safe.txt");
  // 헤더가 준 이름도 다듬는다 — 서버가 경로를 실어도 디렉터리가 되지 않는다.
  assert.equal(responseFileName("attachment; filename=\"../x/y.bin\""), ".._x_y.bin");
  assert.equal(responseFileName("attachment; filename*=UTF-8''"), null);
  // 꼴 이름은 대소문자를 가리지 않고, 풀어서 이름이 남지 않으면 download다.
  assert.equal(responseFileName("attachment; filename*=utf-8''a.txt"), "a.txt");
  assert.equal(responseFileName("attachment; filename*=UTF-8''%20%20"), "download");
  // 구분자 하나뿐인 이름은 비는 것이 아니라 `_`로 바뀐다 — 원래 규칙 그대로다.
  assert.equal(responseFileName("attachment; filename*=UTF-8''%2F"), "_");
  // 따옴표 없는 꼴은 지금 읽지 않는다 — 호출부가 링크 이름으로 내려간다.
  assert.equal(responseFileName("attachment; filename=x.txt"), null);
});
