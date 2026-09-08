import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_HIGHLIGHT_CHARACTERS,
  codeLanguageForPath,
  highlightCode,
} from "./codeHighlight.ts";

test("MAX_HIGHLIGHT_CHARACTERS is 1,000,000", () => {
  assert.equal(MAX_HIGHLIGHT_CHARACTERS, 1_000_000);
});

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

test("highlightCode returns null when content exceeds MAX_HIGHLIGHT_CHARACTERS", async () => {
  const hugeContent = "x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1);
  const lang = { id: "rust", label: "Rust" };
  const tokens = await highlightCode(hugeContent, lang);
  assert.equal(tokens, null);
});

test("highlightCode tokenizes simple code snippet", async () => {
  const code = 'const greeting = "hello";';
  const lang = { id: "typescript", label: "TypeScript" };
  const tokens = await highlightCode(code, lang);
  assert.ok(Array.isArray(tokens));
  assert.ok(tokens.length > 0);
  assert.ok(Array.isArray(tokens[0]));
});
