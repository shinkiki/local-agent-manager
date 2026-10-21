import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('../deploy/synology/entrypoint.sh', import.meta.url));

function runWithIds(uid, gid) {
  const directory = mkdtempSync(join(tmpdir(), 'synology-privdrop-'));
  try {
    const trace = join(directory, 'trace');
    writeFileSync(trace, '');
    writeFileSync(join(directory, 'id'), `#!/bin/sh
if [ "$#" = 1 ]; then echo 0; else echo 1000; fi
`, { mode: 0o700 });
    writeFileSync(join(directory, 'getent'), `#!/bin/sh
echo 'agent:x:1000:1000::/unused:/bin/bash'
`, { mode: 0o700 });
    // V2/L13: run the real root entry path, but stop before any account, volume,
    // privilege or service operation. A missing validation reaches this barrier.
    for (const command of ['groupmod', 'usermod', 'chown', 'setpriv', 'dbus-launch']) {
      writeFileSync(join(directory, command), `#!/bin/sh
printf '%s\\n' '${command}' >> "$PRIVDROP_TEST_TRACE"
exit 91
`, { mode: 0o700 });
    }
    const result = spawnSync('/bin/bash', [entrypoint], {
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        AGENT_MANAGER_USER: 'agent',
        PUID: uid,
        PGID: gid,
        PRIVDROP_TEST_TRACE: trace,
      },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.ifError(result.error);
    return { ...result, trace: readFileSync(trace, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('V2/L13: reject every zero UID/GID before changing accounts or volumes', () => {
  for (const value of ['0', '00', '0000']) {
    for (const [uid, gid] of [[value, '1000'], ['1000', value]]) {
      const result = runWithIds(uid, gid);
      assert.equal(result.status, 1, `PUID=${uid} PGID=${gid}: ${result.stderr}`);
      assert.match(result.stderr, /PUID\/PGID에 0을 쓸 수 없습니다/);
      assert.equal(result.trace, '', `PUID=${uid} PGID=${gid} reached ${result.trace}`);
    }
  }
});

test('V2/L13: reject signed, named and malformed IDs before either account changes', () => {
  for (const value of ['+0', '-0', 'root', '+1000', ' 1000', '1000 ', '1e3', '1000\n']) {
    for (const [uid, gid] of [[value, '100'], ['1027', value]]) {
      const result = runWithIds(uid, gid);
      assert.equal(result.status, 1, `PUID=${uid} PGID=${gid}: ${result.stderr}`);
      assert.match(result.stderr, /PUID\/PGID는 십진수 숫자로만/);
      assert.equal(result.trace, '', `PUID=${uid} PGID=${gid} reached ${result.trace}`);
    }
  }
});

test('V2/L13: retain default, mapped and padded nonzero decimal IDs', () => {
  for (const [uid, gid, firstOperation] of [
    ['1000', '1000', 'chown'],
    ['1027', '100', 'groupmod'],
    ['001027', '000100', 'groupmod'],
    ['', '', 'chown'],
  ]) {
    const result = runWithIds(uid, gid);
    assert.equal(result.status, firstOperation === 'chown' ? 1 : 91, result.stderr);
    assert.equal(result.trace, `${firstOperation}\n`);
  }
});
