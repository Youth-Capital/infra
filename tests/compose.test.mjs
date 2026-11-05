import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createBundle } from '../scripts/controller.mjs';

const environment = {
  DB_HOST: 'postgres', DB_PORT: '5432', DB_NAME: 'yoshlar_kapitali_db', DB_USER: 'yoshlar_kapitali_user', DB_NETWORK: 'infrastructure_database',
  DOMAIN: 'example.test', ACME_EMAIL: 'operations@example.test', DJANGO_SECRET_KEY: 'x'.repeat(60),
  POSTGRES_PASSWORD: `test-only-$#'"\\`.repeat(3), EMAIL_HOST: 'smtp.example.test', EMAIL_HOST_USER: 'test-smtp-user', EMAIL_HOST_PASSWORD: `mail-$#'"\\`,
};
const image = app => `${app.toUpperCase()}_IMAGE=ghcr.io/youth-capital/${app}:${app}-${'a'.repeat(40)}-r1-123-a1@sha256:${'b'.repeat(64)}\n`;

function config(directory, app) {
  const args = ['compose', '-p', 'youthcapital', '--env-file', path.join(directory, 'runtime/compose.env'), '-f', path.join(directory, 'compose.yaml')];
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
    assert.deepEqual(Object.keys(shared.services), ['redis']);
    assert.equal(shared.volumes, undefined);
    assert.ok(shared.services.redis.command.includes('noeviction'));

    writeFileSync(path.join(directory, 'apps/backend/image.env'), image('backend'));
    const backend = config(directory, 'backend');
    assert.equal(backend.networks.database.external, true);
    assert.equal(backend.networks.database.name, environment.DB_NETWORK);
    assert.equal(backend.services['youthcapital-frontend'], undefined);
    assert.equal(backend.services['youthcapital-backend'].user, '10001:10001');
    assert.equal(backend.services['youthcapital-backend'].read_only, true);
    assert.equal(backend.services['youthcapital-backend'].ports[0].host_ip, '127.0.0.1');
    assert.equal(backend.services['youthcapital-backend'].environment.EMAIL_HOST_PASSWORD.replaceAll('$$', '$'), environment.EMAIL_HOST_PASSWORD);
    assert.equal(backend.services['youthcapital-backend'].environment.TMPDIR, '/app/private-media/.tmp');
    assert.ok(backend.services['youthcapital-backend'].volumes.some(volume => volume.target === '/app/private-media'));

    rmSync(path.join(directory, 'apps/backend/image.env'));
    writeFileSync(path.join(directory, 'apps/frontend/image.env'), image('frontend'));
    const frontend = config(directory, 'frontend');
    assert.equal(frontend.services['youthcapital-backend'], undefined);
    assert.equal(frontend.services['youthcapital-frontend'].user, '101:101');
    assert.equal(frontend.services['youthcapital-frontend'].ports[0].host_ip, '127.0.0.1');
    assert.ok(frontend.services['youthcapital-frontend'].healthcheck.test.includes('http://127.0.0.1:8080/healthz'));
    assert.deepEqual(Object.keys(frontend.services['youthcapital-frontend'].networks).sort(), ['edge', 'frontendnet']);
    assert.deepEqual(Object.keys(backend.services['youthcapital-backend'].networks).sort(), ['backendnet', 'database', 'edge']);
    assert.deepEqual(backend.services['youthcapital-backend'].networks.edge.aliases, ['youthcapital-backend']);
    assert.equal(backend.services['youthcapital-backend'].depends_on.postgres, undefined);
    assert.equal(frontend.services['youthcapital-frontend'].networks.database, undefined);
    assert.equal(backend.services.redis.networks.database, undefined);

    // Verify literal secrets without starting any database or Compose stack.
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none',
      '--env-file', path.join(directory, 'runtime/backend.env'),
      'python:3.14.7-alpine@sha256:9e9fde4d32eedce0b661d9ab91e826b62dddf28e928c230ec55f1866cac66b01',
      'python', '-c', 'import os,hashlib; print(hashlib.sha256(os.environ["POSTGRES_PASSWORD"].encode()).hexdigest())'],
      { encoding: 'utf8', timeout: 90_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), createHash('sha256').update(environment.POSTGRES_PASSWORD).digest('hex'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
