import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f';

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('Caddy route/error logs redact signed-download/reset tokens and Referer', async () => {
  // Run the production config on an ephemeral loopback HTTP port; no TLS/DNS/production state.
  const name = `infra-log-test-${Date.now()}`;
  docker(['run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-e', 'DOMAIN=http://localhost:8080', '-e', 'ACME_EMAIL=operations@example.test', '-v', `${path.join(repository, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, image]);
  try {
    const port = docker(['port', name, '8080/tcp']).split(':').at(-1);
    const origin = `http://localhost:${port}`;
    let response;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        response = await fetch(`${origin}/api/signed-download?t=private-download-token&token=private-password-reset-token&keep=route`, {
          headers: { Host: 'localhost:8080', Referer: 'https://example.test/private?t=private-referer-token' },
          signal: AbortSignal.timeout(1000),
        });
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(response, 'Caddy did not start');
    await response.text();
    let logs = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      logs = `${result.stdout}${result.stderr}`;
      if (logs.includes('http.log.access.') && logs.includes('http.log.error.')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(response.status, 502, `missing test upstream should create an error log\n${logs}`);
    assert.ok(logs.includes('http.log.access.'), 'missing access log');
    assert.ok(logs.includes('http.log.error.'), 'missing upstream error log');
    assert.ok(logs.includes('/api/signed-download'));
    assert.ok(logs.includes('keep=route'));
    assert.equal(logs.includes('private-download-token'), false, logs);
    assert.equal(logs.includes('private-password-reset-token'), false, logs);
    assert.equal(logs.includes('private-referer-token'), false, logs);
  } finally { docker(['rm', '-f', name]); }
});
