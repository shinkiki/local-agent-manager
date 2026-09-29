import assert from "node:assert/strict";
import test from "node:test";

import { codeLanguageForPath } from "./codeLanguages.ts";

// 파일명에서 언어를 고르는 규칙만 본다. 하이라이터를 언제 띄우고 어디까지 다루는지는
// codeHighlight.test.mjs가 맡는다 — 모듈이 갈라진 경계와 같다.

test("codeLanguageForPath resolves exact special file names case-insensitively", () => {
  assert.deepEqual(codeLanguageForPath("Dockerfile"), { id: "dockerfile", label: "Dockerfile" });
  assert.deepEqual(codeLanguageForPath("path/to/dockerfile"), { id: "dockerfile", label: "Dockerfile" });
  assert.deepEqual(codeLanguageForPath("Makefile"), { id: "make", label: "Makefile" });
  assert.deepEqual(codeLanguageForPath("C:\\project\\MAKEFILE"), { id: "make", label: "Makefile" });
  assert.deepEqual(codeLanguageForPath("CMakeLists.txt"), { id: "cmake", label: "CMake" });
  assert.deepEqual(codeLanguageForPath("cmakelists.txt"), { id: "cmake", label: "CMake" });
});

test("codeLanguageForPath resolves languages by file extension", () => {
  assert.deepEqual(codeLanguageForPath("src/main.rs"), { id: "rust", label: "Rust" });
  assert.deepEqual(codeLanguageForPath("components/App.tsx"), { id: "tsx", label: "TSX" });
  assert.deepEqual(codeLanguageForPath("server.py"), { id: "python", label: "Python" });
  assert.deepEqual(codeLanguageForPath("data.json"), { id: "json", label: "JSON" });
  assert.deepEqual(codeLanguageForPath("README.md"), { id: "markdown", label: "Markdown" });
  assert.deepEqual(codeLanguageForPath("deploy.sh"), { id: "sh", label: "Shell" });
  assert.deepEqual(codeLanguageForPath("config.yml"), { id: "yaml", label: "YAML" });
});

test("codeLanguageForPath handles paths with multiple dots and uppercase extensions", () => {
  assert.deepEqual(codeLanguageForPath("app.component.test.ts"), { id: "typescript", label: "TypeScript" });
  assert.deepEqual(codeLanguageForPath("IMAGE.PNG.RS"), { id: "rust", label: "Rust" });
});

test("codeLanguageForPath handles Windows path separators", () => {
  assert.deepEqual(codeLanguageForPath("C:\\Users\\dev\\project\\src\\index.js"), {
    id: "javascript",
    label: "JavaScript",
  });
});

test("codeLanguageForPath returns null for extensionless or unknown files", () => {
  assert.equal(codeLanguageForPath("LICENSE"), null);
  assert.equal(codeLanguageForPath(""), null);
  assert.equal(codeLanguageForPath("archive.xyz123"), null);
});
