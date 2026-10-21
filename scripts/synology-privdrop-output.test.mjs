import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(new URL('../deploy/synology/test-privdrop.sh', import.meta.url), 'utf8');

// Exercise the real reporting helpers without building an image or starting Docker.
function checkLog(helper, output) {
  const start = source.indexOf(`\n${helper}() {`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1);
  const definition = source.slice(start, end + 3);
  const directory = mkdtempSync(join(tmpdir(), 'privdrop-output-'));
  try {
    const log = join(directory, 'output');
    writeFileSync(log, output);
    const invocation = helper === 'expect'
      ? 'expect probe RUN-UID= "$output"'
      : 'expect_no_server probe "$output"';
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
${definition}
fail=0
output=$(cat "$PRIVDROP_TEST_LOG")
${invocation} > /dev/null
exit "$fail"
`], {
      env: { PATH: '/usr/bin:/bin', PRIVDROP_TEST_LOG: log },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [helper, status] of [['expect', 0], ['expect_no_server', 1]]) {
  test(`V2/L13: ${helper} matches a startup marker before a long unread tail`, () => {
    const output = `RUN-UID=1000\n${'x'.repeat(16 * 1024 * 1024)}`;
    assert.equal(checkLog(helper, output).status, status);
  });
}

test('V2/L13: missing startup markers retain both reporting outcomes', () => {
  assert.equal(checkLog('expect', 'keyring failed').status, 1);
  assert.equal(checkLog('expect_no_server', 'keyring failed').status, 0);
});
