import assert from "node:assert/strict";
import test from "node:test";

import {
  documentEntriesForParent,
  documentFileName,
  mergeDocumentEntries,
  mergeDocumentEntryPage,
} from "./documentWorkspace.ts";

function entry(relativePath, overrides = {}) {
  const parts = relativePath.split("/");
  return {
    name: parts.at(-1),
    relativePath,
    parentPath: parts.slice(0, -1).join("/"),
    sizeBytes: 10,
    modifiedAt: 1,
    isDirectory: false,
    previewKind: "text",
    ...overrides,
  };
}

test("folder pages append in server order and replace duplicate metadata", () => {
  let cache = new Map();
  cache = mergeDocumentEntryPage(cache, "", {
    entries: [entry("alpha.txt"), entry("nested", { isDirectory: true, previewKind: null })],
    nextCursor: "page-2",
    total: 3,
  }, false);
  cache = mergeDocumentEntryPage(cache, "", {
    entries: [entry("alpha.txt", { sizeBytes: 99 }), entry("omega.bin", { previewKind: "binary" })],
    nextCursor: null,
    total: 3,
  }, true);

  const entries = documentEntriesForParent(cache, "");
  assert.deepEqual(entries.map((item) => item.relativePath), ["alpha.txt", "nested", "omega.bin"]);
  assert.equal(entries[0].sizeBytes, 99);
  assert.equal(cache.get("").nextCursor, null);
});

test("loading a first page replaces stale folder children", () => {
  const previous = new Map([["docs", {
    entries: [entry("docs/old.md", { previewKind: "markdown" })],
    nextCursor: null,
    total: 1,
    loaded: true,
  }]]);
  const next = mergeDocumentEntryPage(previous, "docs", {
    entries: [entry("docs/new.md", { previewKind: "markdown" })],
    nextCursor: null,
    total: 1,
  }, false);

  assert.deepEqual(documentEntriesForParent(next, "docs").map((item) => item.name), ["new.md"]);
  assert.deepEqual(documentEntriesForParent(previous, "docs").map((item) => item.name), ["old.md"]);
});

test("flat search page merging removes duplicate paths", () => {
  const merged = mergeDocumentEntries(
    [entry("docs/report.md", { previewKind: "markdown", sizeBytes: 5 })],
    [entry("docs/report.md", { previewKind: "markdown", sizeBytes: 8 }), entry("src/main.rs")],
  );
  assert.deepEqual(merged.map((item) => item.relativePath), ["docs/report.md", "src/main.rs"]);
  assert.equal(merged[0].sizeBytes, 8);
});

test("mergeDocumentEntries preserves original order while updating duplicates and appending new entries", () => {
  const current = [
    entry("alpha.txt", { sizeBytes: 1 }),
    entry("beta.txt", { sizeBytes: 2 }),
    entry("gamma.txt", { sizeBytes: 3 }),
  ];
  const incoming = [
    entry("beta.txt", { sizeBytes: 20 }),
    entry("delta.txt", { sizeBytes: 4 }),
  ];
  const merged = mergeDocumentEntries(current, incoming);
  assert.deepEqual(merged.map((item) => item.relativePath), ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt"]);
  assert.equal(merged[1].sizeBytes, 20);
  assert.equal(merged[3].sizeBytes, 4);
});

test("file names preserve extensions and normalize separators", () => {
  assert.equal(documentFileName("docs/Guide.MD"), "Guide.MD");
  assert.equal(documentFileName("src\\main.rs"), "main.rs");
});

