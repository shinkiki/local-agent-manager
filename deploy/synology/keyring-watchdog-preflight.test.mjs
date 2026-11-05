import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./test-keyring-watchdog.sh", import.meta.url));
const requiredTools = ["dbus-launch", "dbus-send", "gnome-keyring-daemon", "secret-tool", "pgrep"];

for (const missingTool of requiredTools) {
  test(`V2: missing ${missingTool} skips the watchdog test instead of reporting success`, {
    skip: process.platform !== "linux",
  }, () => {
    const bin = mkdtempSync(join(tmpdir(), "keyring-preflight-"));
    try {
      symlinkSync("/usr/bin/dirname", join(bin, "dirname"));
      for (const tool of requiredTools.filter((tool) => tool !== missingTool)) {
        // Availability markers only: no real keyring or session bus can be started.
        const marker = join(bin, tool);
        writeFileSync(marker, "");
        chmodSync(marker, 0o755);
      }
      // mktemp is deliberately absent too, so reaching setup is a failure before
      // the script can change HOME or contact the real keyring.
      const result = spawnSync("/bin/bash", [script], {
        env: { PATH: bin },
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 77, result.stdout + result.stderr);
      assert.equal(result.stdout, `SKIP ${missingTool} 없음 — gnome-keyring이 든 환경에서 돌리세요\n`);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
}
