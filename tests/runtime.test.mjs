import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { envFile, parseImage, renderRuntime, verifyRelease, writeRuntime } from '../scripts/runtime.mjs';
import { createBundle, remoteCommand, shellQuote, sshSettings } from '../scripts/controller.mjs';

export const fixtureEnv = {
  DOMAIN: 'example.test', ACME_EMAIL: 'operations@example.test',
  DJANGO_SECRET_KEY: 'k'.repeat(60), POSTGRES_PASSWORD: `long-password-\u0024\u0023'\"\\-`.repeat(2),
  EMAIL_HOST: 'smtp.example.test', EMAIL_HOST_USER: 'test-smtp-user', EMAIL_HOST_PASSWORD: `mail-\u0024\u0023'\"\\`,
};
export const image = app => `ghcr.io/youth-capital/${app}:${app}-${'a'.repeat(40)}-r4-12345-a1@sha256:${'b'.repeat(64)}`;
const manifest = app => `${app.toUpperCase()}_IMAGE=${image(app)}\n`;
const temporary = () => mkdtempSync(path.join(tmpdir(), 'youthcapital-test-'));

test('runtime preserves punctuation and percent-encodes database credentials', () => {
  const files = renderRuntime(fixtureEnv);
  assert.ok(files['postgres.env'].includes(`POSTGRES_PASSWORD=${fixtureEnv.POSTGRES_PASSWORD}\n`));
  assert.ok(files['backend.env'].includes(`EMAIL_HOST_PASSWORD=${fixtureEnv.EMAIL_HOST_PASSWORD}\n`));
  const url = files['backend.env'].match(/^DATABASE_URL=(.+)$/m)[1];
  assert.equal(decodeURIComponent(new URL(url).password), fixtureEnv.POSTGRES_PASSWORD);
  assert.ok(files['backend.env'].includes('DJANGO_ALLOWED_HOSTS=example.test,localhost\n'));
  assert.ok(files['backend.env'].includes('CELERY_BROKER_URL=\n'));
});

test('runtime rejects line injection without including the secret in its error', () => {
  const bad = `${'s'.repeat(60)}\nINJECTED=yes`;
  assert.throws(() => renderRuntime({ ...fixtureEnv, DJANGO_SECRET_KEY: bad }), error => !error.message.includes(bad) && error.message.includes('single-line'));
  assert.throws(() => envFile({ PASSWORD: 'hello\0there' }));
  assert.throws(() => renderRuntime({ ...fixtureEnv, DOMAIN: 'example.test;id' }));
});

test('runtime files are private on Linux', () => {
  const directory = temporary();
  try {
    writeRuntime(directory, fixtureEnv);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(directory, 'backend.env')).mode & 0o777, 0o600);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('empty/bootstrap, mutable and shell-injected manifests are rejected', () => {
  for (const text of ['', '# Bootstrap only\n', 'BACKEND_IMAGE=\n', 'BACKEND_IMAGE=ghcr.io/example/backend:latest\n', 'BACKEND_IMAGE=$(id)\n', `${manifest('backend')}OTHER=value\n`, manifest('backend').replace('youth-capital/', 'other-owner/'), manifest('backend').replace('-r4-', '-r0-'), manifest('backend').replace('-a1@', '-a0@')]) {
    assert.throws(() => parseImage('backend', text));
  }
  assert.equal(parseImage('backend', manifest('backend')), image('backend'));
});

test('requested and latest-main images both must match the event commit', () => {
  assert.equal(verifyRelease('backend', manifest('backend'), image('backend'), manifest('backend')), image('backend'));
  assert.throws(() => verifyRelease('backend', manifest('backend'), image('frontend'), manifest('backend')), /workflow commit/);
  assert.throws(() => verifyRelease('backend', manifest('backend'), '', manifest('backend').replace('-r4-', '-r5-')), /superseded/);
});

test('normal app bundle cannot overwrite sibling release or runtime/config', () => {
  const directory = temporary();
  try {
    createBundle(directory, { mode: 'deploy', app: 'backend', shared: false });
    assert.ok(existsSync(path.join(directory, 'apps/backend/image.env')));
    for (const name of ['runtime', 'compose.yaml', 'Caddyfile', 'apps/frontend', 'scripts']) assert.equal(existsSync(path.join(directory, name)), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('shared/bootstrap bundle contains config but no release files', () => {
  const directory = temporary();
  try {
    createBundle(directory, { mode: 'bootstrap', shared: true, env: fixtureEnv });
    assert.ok(existsSync(path.join(directory, 'runtime/backend.env')));
    assert.ok(existsSync(path.join(directory, 'apps/frontend/compose.yaml')));
    assert.equal(existsSync(path.join(directory, 'apps/backend/image.env')), false);
    assert.equal(existsSync(path.join(directory, 'apps/frontend/image.env')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('SSH rejects option injection, pins host trust and brackets IPv6 SCP', () => {
  const directory = temporary();
  const env = { VPS_HOST: '2001:db8::1', VPS_USERNAME: 'deploy', VPS_SSH_KEY: 'test-key\r\nsecond-line', VPS_KNOWN_HOSTS: 'test-known-host' };
  try {
    const settings = sshSettings(env, directory);
    assert.equal(settings.destination, 'deploy@[2001:db8::1]');
    assert.ok(settings.ssh.includes('StrictHostKeyChecking=yes'));
    assert.equal(readFileSync(path.join(directory, 'ssh-key'), 'utf8'), 'test-key\nsecond-line\n');
    assert.throws(() => sshSettings({ ...env, VPS_HOST: '-V' }, directory));
    assert.throws(() => sshSettings({ ...env, VPS_USERNAME: 'root' }, directory), /non-root/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('transport has bounded commands, stdin authentication and cleanup', () => {
  const command = remoteCommand({ mode: 'deploy', app: 'backend', shared: false, remote: '/tmp/youthcapital.ABC123', actor: 'deploy-app[bot]', port: 22 });
  assert.ok(command.includes('--password-stdin'));
  assert.ok(command.includes('sudo -n timeout --signal=TERM --kill-after=15s 60s docker'));
  assert.ok(command.includes('unset registry_token'));
  assert.ok(command.includes('rm -rf'));
  assert.ok(command.includes('12m bash -c'));
  assert.equal(command.includes('apply-shared.sh'), false);
  assert.throws(() => remoteCommand({ mode: 'deploy', app: 'backend', shared: false, remote: "/tmp/x';id", actor: 'deploy-app[bot]', port: 22 }));
});

test('fresh bootstrap succeeds without Docker and cleans staging/registry files', { skip: process.platform === 'win32' }, () => {
  const remote = mkdtempSync('/tmp/youthcapital.');
  const directory = temporary();
  const bin = path.join(directory, 'bin');
  const receipt = path.join(directory, 'receipt');
  mkdirSync(bin);
  mkdirSync(path.join(remote, 'scripts'));
  try {
    for (const tool of ['sh', 'bash', 'tar', 'gzip', 'mktemp', 'rm', 'timeout', 'env']) {
      const executable = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
      assert.equal(executable.status, 0);
      symlinkSync(executable.stdout.trim(), path.join(bin, tool));
    }
    // No docker binary exists on this simulated fresh machine.
    writeFileSync(path.join(bin, 'sudo'), '#!/bin/bash\n[[ "$1" == -n ]] && shift\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(path.join(remote, 'scripts/bootstrap.sh'), '#!/bin/bash\n[[ "$2" == 22 && -d "$DOCKER_CONFIG" ]] || exit 1\nprintf "%s" "$DOCKER_CONFIG" > "$TEST_RECEIPT"\n');
    const archive = spawnSync('tar', ['-C', remote, '-czf', path.join(remote, 'bundle.tar.gz'), 'scripts'], { encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    const command = remoteCommand({ mode: 'bootstrap', shared: true, remote, actor: 'deploy-app[bot]', port: 22 });
    const result = spawnSync('sh', ['-c', command], { input: 'test-only-registry-token\n', env: { ...process.env, PATH: bin, TEST_RECEIPT: receipt }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(remote), false);
    assert.equal(existsSync(readFileSync(receipt, 'utf8')), false);
    assert.equal(result.stdout.includes('test-only-registry-token'), false);
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shell quoting preserves literal dollar, apostrophe and command substitution', { skip: process.platform === 'win32' }, () => {
  const literal = `a'b \u0024HOME \u0024(touch /tmp/this-must-not-run)`;
  const result = spawnSync('sh', ['-c', `printf '%s' ${shellQuote(literal)}`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, literal);
});
