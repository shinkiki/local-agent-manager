import assert from "node:assert/strict";
import test from "node:test";
import { isMarkdownPath, parseLinkPath, resolveDocLinkPath } from "./docLinkPath.ts";

test("링크 표기에서 꺾쇠·인코딩·쿼리·해시·줄 번호를 걷어낸다", () => {
  assert.equal(parseLinkPath(" <docs/My%20Note.md> "), "docs/My Note.md");
  assert.equal(parseLinkPath("guide.md?raw=1#intro"), "guide.md");
  assert.equal(parseLinkPath("src\\notes\\a.md:12"), "src/notes/a.md");
});

test("디코드할 수 없는 링크는 버린다", () => {
  assert.equal(parseLinkPath("bad%E0%A4%A.md"), null);
});

test("Markdown 확장자는 대소문자를 가리지 않는다", () => {
  assert.equal(isMarkdownPath("A.MD"), true);
  assert.equal(isMarkdownPath("a.mdx"), false);
});

test("상대 링크는 현재 문서 폴더에 얹어 정규화한다", () => {
  assert.equal(resolveDocLinkPath("/r", "a/b/cur.md", "../c.md"), "a/c.md");
  assert.equal(resolveDocLinkPath("/r", "cur.md", "./x//y.md"), "x/y.md");
});

test("등록 폴더 위로 벗어나는 링크는 거절한다", () => {
  assert.equal(resolveDocLinkPath("/r", "cur.md", "../out.md"), null);
  assert.equal(resolveDocLinkPath("/r", "a/cur.md", "../.."), null);
});

test("절대 경로는 등록 폴더 접두사를 대소문자 무시로 벗긴다", () => {
  assert.equal(resolveDocLinkPath("/Users/me/Docs/", "x.md", "/users/me/docs/sub/a.md"), "sub/a.md");
  assert.equal(resolveDocLinkPath("C:\\Docs", "x.md", "c:/docs/a.md"), "a.md");
});

test("등록 폴더 밖 절대 경로는 폴더 기준으로 읽고, 다른 드라이브는 거절한다", () => {
  assert.equal(resolveDocLinkPath("/r", "x.md", "/other/a.md"), "other/a.md");
  assert.equal(resolveDocLinkPath("C:/Docs", "x.md", "d:/a.md"), null);
});
