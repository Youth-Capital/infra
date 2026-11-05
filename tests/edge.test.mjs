import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createBundle } from '../scripts/controller.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caddy = 'caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f';
const fixture = {
  DOMAIN: 'youth.example.test', ACME_EMAIL: 'ops@example.test', DJANGO_SECRET_KEY: 'x'.repeat(60),
  DB_HOST: 'postgres', DB_PORT: '5432', DB_NAME: 'yoshlar_kapitali_db',
  DB_USER: 'yoshlar_kapitali_user', DB_NETWORK: 'infrastructure_database',
  POSTGRES_PASSWORD: 'test-only-'.repeat(4), EMAIL_HOST: 'smtp.example.test',
  EMAIL_HOST_USER: 'test-smtp-user', EMAIL_HOST_PASSWORD: 'test-smtp-password',
};

function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

test('standalone and merged edge configurations validate without listeners or certificate issuance', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'yc-edge-'));
  try {
    createBundle(directory, { mode: 'bootstrap', shared: true, env: fixture });
    const site = readFileSync(path.join(directory, 'edge/site.caddy'), 'utf8');
    assert.ok(site.startsWith('youth.example.test {'));
    assert.ok(site.includes('disable_tlsalpn_challenge'));
    assert.equal(site.includes('{$DOMAIN}'), false);
    assert.equal(site.includes('private-media:/'), false);
    for (const config of [path.join(root, 'Caddyfile'), path.join(root, 'edge/Caddyfile')]) {
      docker(['run', '--rm', '--network', 'none', '-e', 'DOMAIN=edge.example.test',
        '-e', 'ACME_EMAIL=ops@example.test',
        '-v', `${config}:/etc/caddy/Caddyfile:ro`,
        '-v', `${path.join(directory, 'edge')}:/etc/caddy/youthcapital:ro`,
        caddy, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('edge override preserves existing networks and volumes without exposing private media or runtime', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'yc-edge-compose-'));
  try {
    mkdirSync(path.join(directory, 'edge'));
    writeFileSync(path.join(directory, 'compose.yaml'), JSON.stringify({
      name: 'agrozanjir', services: { caddy: { image: caddy, networks: ['web'],
        ports: ['80:80', '443:443', '443:443/udp'], volumes: [
          '/opt/agrozanjir/data/caddy:/data', '/opt/agrozanjir/data/media:/srv/media:ro',
        ] } }, networks: { web: {} },
    }));
    const config = JSON.parse(docker(['compose', '-p', 'agrozanjir',
      '-f', path.join(directory, 'compose.yaml'), '-f', path.join(root, 'edge/compose.override.yaml'),
      'config', '--format', 'json']));
    const proxy = config.services.caddy;
    assert.deepEqual(Object.keys(proxy.networks).sort(), ['web', 'youthcapital_edge']);
    assert.equal(proxy.ports.length, 3);
    assert.deepEqual(proxy.volumes.map(volume => volume.target).sort(),
      ['/data', '/etc/caddy/youthcapital', '/srv/media', '/srv/youthcapital/media']);
    assert.equal(config.networks.youthcapital_edge.external, true);
    assert.equal(proxy.volumes.some(volume => /private-media|runtime/.test(volume.source)), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
