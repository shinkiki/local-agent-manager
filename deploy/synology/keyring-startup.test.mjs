import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entrypoint = fileURLToPath(new URL("./entrypoint.sh", import.meta.url));

for (const mode of ["opened", "empty", "failed", "hung", "unresponsive"]) {
  test(`V2/G4: initial keyring unlock handles ${mode} without contacting a vault`, {
    skip: process.platform !== "linux",
  }, () => {
    const bin = mkdtempSync(join(tmpdir(), "keyring-startup-"));
    try {
      writeFileSync(join(bin, "gnome-keyring-daemon"), `#!/bin/bash
[ "$*" = "--unlock --components=secrets" ] || exit 41
[ -z "\${KEYRING_PASSWORD+x}" ] || exit 42
IFS= read -r -d '' password || true
[ "$password" = fixture-password ] || exit 43
case "$AM_TEST_UNLOCK_MODE" in
  opened) printf 'GNOME_KEYRING_CONTROL=/fixture/control\\nSSH_AUTH_SOCK=/fixture/socket\\n' ;;
  empty) exit 0 ;;
  failed) printf 'GNOME_KEYRING_CONTROL=/fixture/partial\\n'; exit 1 ;;
  hung) exec /usr/bin/sleep 2 ;;
  unresponsive) trap '' TERM; exec /usr/bin/sleep 3 ;;
esac
`, { mode: 0o755 });
      // Exercise the real timeout, shortening only its duration for the fixture.
      writeFileSync(join(bin, "timeout"), `#!/bin/bash
[ "$1" = --kill-after=5 ] && [ "$2" = 30 ] || exit 44
shift 2
/usr/bin/timeout --kill-after=0.2 1 "$@"
status=$?
printf '%s' "$status" > "$AM_TEST_UNLOCK_STATUS"
exit "$status"
`, { mode: 0o755 });
      const result = spawnSync("/bin/bash", ["-c", `
source "$1"
if unlock_keyring fixture-password; then
  printf 'opened:%s:%s\\n' "\${GNOME_KEYRING_CONTROL-unset}" "\${SSH_AUTH_SOCK-unset}"
else
  printf 'failed:%s:%s\\n' "\${GNOME_KEYRING_CONTROL-unset}" "\${SSH_AUTH_SOCK-unset}"
  exit 1
fi
`, "_", entrypoint], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          AM_TEST_UNLOCK_MODE: mode,
          AM_TEST_UNLOCK_STATUS: join(bin, "status"),
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      const expectedStatus = { opened: "0", empty: "0", failed: "1", hung: "124", unresponsive: "137" };
      assert.equal(readFileSync(join(bin, "status"), "utf8"), expectedStatus[mode]);
      const succeeds = mode === "opened" || mode === "empty";
      assert.equal(result.status, succeeds ? 0 : 1, result.stdout + result.stderr);
      assert.equal(result.stdout, mode === "opened"
        ? "opened:/fixture/control:/fixture/socket\n"
        : `${succeeds ? "opened" : "failed"}:unset:unset\n`);
      if (succeeds) {
        assert.equal(result.stderr, "");
      } else {
        assert.match(result.stderr, /잠금 해제 명령이 실패했거나 30초 안에 끝나지 않았습니다/);
      }
      assert.ok(!(result.stdout + result.stderr).includes("fixture-password"));
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
}
