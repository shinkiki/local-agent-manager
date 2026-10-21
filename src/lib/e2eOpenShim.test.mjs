import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeOpenShim } from "../../scripts/e2e-open-shim.mjs";

const logDirectories = [
  "plain",
  "spaces and 'single' and \"double\"",
  "$(touch injected-dollar)-`touch injected-backtick`-$HOME",
  "line\nbreak",
];

for (const directory of logDirectories) {
  test(`G9: open shim treats log path as literal: ${JSON.stringify(directory)}`, {
    skip: process.platform === "win32",
  }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-open-shim-test-"));
    try {
      const bin = path.join(root, "bin");
      const logPath = path.join(root, directory, "blocked-open.log");
      fs.mkdirSync(bin);
      fs.mkdirSync(path.dirname(logPath));
      writeOpenShim(bin, logPath);
      const args = ["https://example.invalid/login?x=1&y=2", "two words"];
      for (let call = 0; call < 2; call += 1) {
        const result = spawnSync("/bin/sh", [path.join(bin, "open"), ...args], {
          cwd: root,
          encoding: "utf8",
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(path.join(root, "injected-dollar")), false);
        assert.equal(fs.existsSync(path.join(root, "injected-backtick")), false);
        assert.equal(result.stderr, "");
      }
      assert.equal(fs.readFileSync(logPath, "utf8"), `${args.join(" ")}\n`.repeat(2));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
