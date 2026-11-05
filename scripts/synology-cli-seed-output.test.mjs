import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(new URL('../deploy/synology/test-cli-seed.sh', import.meta.url), 'utf8');
const start = source.indexOf('\nexpect() {');
assert.notEqual(start, -1);
const end = source.indexOf('\n}\n', start);
assert.notEqual(end, -1);
const definition = source.slice(start, end + 3);

// Exercise the actual helper under its script's shell flags without starting Docker.
function checkLog(needle, output) {
  const directory = mkdtempSync(join(tmpdir(), 'cli-seed-output-'));
  try {
    const log = join(directory, 'output');
    writeFileSync(log, output);
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
${definition}
fail=0
output=$(cat "$CLI_SEED_TEST_LOG")
expect probe "$CLI_SEED_TEST_NEEDLE" "$output" > /dev/null
exit "$fail"
`], {
      env: { PATH: '/usr/bin:/bin', CLI_SEED_TEST_LOG: log, CLI_SEED_TEST_NEEDLE: needle },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result.status;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('V2: CLI seed success marker before a long log tail remains a success', () => {
  const output = `FOUND claude=/home/agent/.local/bin/claude RUNS=seed-claude\n${'x'.repeat(16 * 1024 * 1024)}`;
  assert.equal(checkLog('RUNS=seed-claude', output), 0);
});

test('V2: CLI seed success marker after other log lines remains a success', () => {
  assert.equal(checkLog('RUNS=seed-codex', 'initializing\nRUNS=seed-codex'), 0);
});

test('V2: missing CLI seed success marker still fails the script', () => {
  assert.equal(checkLog('RUNS=seed-agy', 'CLI agy failed to start'), 1);
});

test('V2: CLI seed log matching keeps fixed-string and leading-dash needles', () => {
  assert.equal(checkLog('-seed[1]', '-seed[1]'), 0);
  assert.equal(checkLog('-seed[1]', '-seed1'), 1);
});
