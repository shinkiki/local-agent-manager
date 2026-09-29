import assert from "node:assert/strict";
import test from "node:test";

import { folderDropMessage, splitDroppedFolders } from "./fileDrop.ts";

const fileItem = (entry) => ({ kind: "file", webkitGetAsEntry: () => entry });

test("폴더로 들어온 항목은 파일 목록에서 이름으로 걸러진다", () => {
  const items = [fileItem({ isDirectory: true, name: "문서모음" }), fileItem({ isDirectory: false, name: "메모.txt" })];
  const files = [{ name: "문서모음" }, { name: "메모.txt" }];
  const result = splitDroppedFolders(items, files);
  assert.deepEqual(result.folderNames, ["문서모음"]);
  assert.deepEqual(result.files, [{ name: "메모.txt" }]);
});

test("파일만 놓으면 아무것도 걸러내지 않는다", () => {
  const items = [fileItem({ isDirectory: false, name: "메모.txt" })];
  const files = [{ name: "메모.txt" }];
  assert.deepEqual(splitDroppedFolders(items, files), { files: [{ name: "메모.txt" }], folderNames: [] });
});

// 글자 드래그 등 파일이 아닌 항목과, 항목 정보를 주지 않는 브라우저에서도 파일은 그대로 지난다.
test("파일이 아닌 항목과 entry 없는 항목은 건너뛴다", () => {
  const items = [{ kind: "string" }, { kind: "file" }, fileItem(null)];
  const files = [{ name: "메모.txt" }];
  assert.deepEqual(splitDroppedFolders(items, files), { files: [{ name: "메모.txt" }], folderNames: [] });
});

test("안내는 폴더가 하나일 때만 이름을 붙인다", () => {
  assert.equal(folderDropMessage(["문서모음"]), "문서모음: 폴더는 첨부할 수 없습니다. 안의 파일을 골라 주세요.");
  assert.equal(folderDropMessage(["가", "나"]), "폴더는 첨부할 수 없습니다. 안의 파일을 골라 주세요.");
  // 이름을 읽지 못한 폴더도 첨부되지 않았다는 사실은 알려야 한다.
  assert.equal(folderDropMessage([""]), "폴더는 첨부할 수 없습니다. 안의 파일을 골라 주세요.");
});
