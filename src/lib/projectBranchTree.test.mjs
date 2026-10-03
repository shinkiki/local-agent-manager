import assert from "node:assert/strict";
import test from "node:test";
import { buildBranchTree } from "./projectBranchTree.ts";

test("buildBranchTree renders slash branch names as virtual folders without ref side effects", () => {
  const tree = buildBranchTree(["feature/auth/login", "feature/auth/logout", "main", "release/1.0"]);

  assert.deepEqual(tree, [
    {
      name: "feature", path: "feature", branches: [], children: [{
        name: "auth", path: "feature/auth", branches: [], children: [
          { name: "login", path: "feature/auth/login", branches: ["feature/auth/login"], children: [] },
          { name: "logout", path: "feature/auth/logout", branches: ["feature/auth/logout"], children: [] },
        ],
      }],
    },
    { name: "main", path: "main", branches: ["main"], children: [] },
    { name: "release", path: "release", branches: [], children: [{ name: "1.0", path: "release/1.0", branches: ["release/1.0"], children: [] }] },
  ]);
});
