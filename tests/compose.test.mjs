import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createBundle } from '../scripts/controller.mjs';

const environment = {
  DOMAIN: 'example.test', ACME_EMAIL: 'operations@example.test', DJANGO_SECRET_KEY: 'x'.repeat(60),
  POSTGRES_PASSWORD: `test-only-$#'"\\`.repeat(3), EMAIL_HOST: 'smtp.example.test', EMAIL_HOST_USER: 'test-smtp-user', EMAIL_HOST_PASSWORD: `mail-$#'"\\`,
};
const image = app => `${app.toUpperCase()}_IMAGE=ghcr.io/youth-capital/${app}:${app}-${'a'.repeat(40)}-r1-123-a1@sha256:${'b'.repeat(64)}\n`;

function config(directory, app) {
  const args = ['compose', '-p', 'youthcapital', '-f', path.join(directory, 'compose.yaml')];
  if (app) args.push('-f', path.join(directory, 'apps', app, 'compose.yaml'), '--env-file', path.join(directory, 'apps', app, 'image.env'));
  args.push('config', '--format', 'json');
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('first deployment models need no sibling release and retain literal secrets', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'youthcapital-compose-'));
  try {
    createBundle(directory, { mode: 'bootstrap', shared: true, env: environment });
    const shared = config(directory);
    assert.deepEqual(Object.keys(shared.services).sort(), ['postgres', 'redis']);
    assert.equal(shared.services.postgres.volumes[0].target, '/var/lib/postgresql');
    // `config` serializes dollars as $$ so its output can be safely reloaded.
    assert.equal(shared.services.postgres.environment.POSTGRES_PASSWORD.replaceAll('$$', '$'), environment.POSTGRES_PASSWORD);
    assert.equal(shared.services.postgres.ports, undefined);
    assert.ok(shared.services.redis.command.includes('noeviction'));

    writeFileSync(path.join(directory, 'apps/backend/image.env'), image('backend'));
    const backend = config(directory, 'backend');
    assert.equal(backend.services.frontend, undefined);
    assert.equal(backend.services.backend.user, '10001:10001');
    assert.equal(backend.services.backend.read_only, true);
    assert.equal(backend.services.backend.ports[0].host_ip, '127.0.0.1');
    assert.equal(backend.services.backend.environment.EMAIL_HOST_PASSWORD.replaceAll('$$', '$'), environment.EMAIL_HOST_PASSWORD);
    assert.equal(backend.services.backend.environment.TMPDIR, '/app/private-media/.tmp');
    assert.ok(backend.services.backend.volumes.some(volume => volume.target === '/app/private-media'));

    rmSync(path.join(directory, 'apps/backend/image.env'));
    writeFileSync(path.join(directory, 'apps/frontend/image.env'), image('frontend'));
    const frontend = config(directory, 'frontend');
    assert.equal(frontend.services.backend, undefined);
    assert.equal(frontend.services.frontend.user, '101:101');
    assert.equal(frontend.services.frontend.ports[0].host_ip, '127.0.0.1');
    assert.ok(frontend.services.frontend.healthcheck.test.includes('http://127.0.0.1:8080/healthz'));
    assert.deepEqual(Object.keys(frontend.services.frontend.networks), ['frontendnet']);
    assert.deepEqual(Object.keys(frontend.services.postgres.networks), ['backendnet']);

    // Verify the actual container environment too, not just Compose serialization.
    const project = `infra-env-test-${Date.now()}`;
    const flags = ['compose', '-p', project, '-f', path.join(directory, 'compose.yaml')];
    try {
      const result = spawnSync('docker', [...flags, 'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'postgres', '-c', 'printf %s "$POSTGRES_PASSWORD" | sha256sum'], { encoding: 'utf8', timeout: 90_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim().split(/\s+/)[0], createHash('sha256').update(environment.POSTGRES_PASSWORD).digest('hex'));
    } finally {
      const result = spawnSync('docker', [...flags, 'down', '--volumes'], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
