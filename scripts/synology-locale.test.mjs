import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Explicit image selection keeps this test away from running containers and NAS data.
const image = process.env.SYNOLOGY_LOCALE_TEST_IMAGE;
assert.ok(image, 'Set SYNOLOGY_LOCALE_TEST_IMAGE to the freshly built Synology image');

function docker(args) {
  const result = spawnSync('docker', args, { timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr?.toString());
  return result;
}

test('L04: the built image declares the UTF-8 locale', () => {
  const result = docker(['image', 'inspect', '--format', '{{json .Config.Env}}', image]);
  assert.ok(JSON.parse(result.stdout.toString()).includes('LANG=C.UTF-8'));
});

test('L04: a Linux login terminal preserves Korean UTF-8 through a PTY', () => {
  // Docker allocates a real Linux PTY. The login-shell argv matches terminal.rs (-l).
  const result = docker([
    'run', '--rm', '--platform', 'linux/amd64', '-t', '--network', 'none', '--entrypoint', '/bin/sh', image,
    '-l', '-c', 'locale charmap; printf "터미널 한글 출력\\n"; printf "터미널 한글 오류\\n" >&2',
  ]);
  assert.deepEqual(result.stdout, Buffer.from('UTF-8\r\n터미널 한글 출력\r\n터미널 한글 오류\r\n'));
});

test('L04: a Node CLI inherits LANG and preserves Korean argv, stdout and stderr', () => {
  const result = docker([
    'run', '--rm', '--platform', 'linux/amd64', '--network', 'none', '--entrypoint', 'node', image,
    '-e', 'if (process.env.LANG !== "C.UTF-8") process.exit(1); process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]);',
    'CLI 한글 출력', 'CLI 한글 오류',
  ]);
  assert.deepEqual(result.stdout, Buffer.from('CLI 한글 출력'));
  assert.deepEqual(result.stderr, Buffer.from('CLI 한글 오류'));
});
