import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('bootstrap prepares only project files and units on a provisioned host', () => {
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none',
    '-v', `${repository}:/src:ro`, '-w', '/src',
    'node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20',
    'bash', 'tests/bootstrap.test.sh'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
