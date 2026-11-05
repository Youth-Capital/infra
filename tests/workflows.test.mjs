import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderRuntime } from '../scripts/runtime.mjs';
const fixtureEnv = {
  DOMAIN: 'example.test', ACME_EMAIL: 'ops@example.test', DJANGO_SECRET_KEY: 'x'.repeat(60),
  DB_HOST: 'postgres', DB_PORT: '5432', DB_NAME: 'yoshlar_kapitali_db',
  DB_USER: 'yoshlar_kapitali_user', DB_NETWORK: 'infrastructure_database',
  POSTGRES_PASSWORD: 'test-only-'.repeat(4), EMAIL_HOST: 'smtp.example.test',
  EMAIL_HOST_USER: 'test-smtp-user', EMAIL_HOST_PASSWORD: 'test-smtp-password',
};

test('all runtime deployment paths forward shared database settings from prod', () => {
  for (const workflow of ['deploy-backend', 'deploy-frontend', 'server-bootstrap']) {
    const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8');
    for (const name of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_NETWORK']) {
      assert.ok(source.includes(`vars.${name}`), `${workflow} must forward ${name}`);
    }
    assert.ok(source.includes('DB_USER: ${{ secrets.DB_USER }}'));
    assert.ok(source.includes('POSTGRES_PASSWORD: ${{ secrets.POSTGRES_PASSWORD }}'));
    assert.equal(source.includes('vars.POSTGRES_USER'), false);
    assert.equal(source.includes('POSTGRES_ADMIN'), false);
  }
});

test('runtime requires the verified database and secret role and accepts custom host/port/network', () => {
  for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_NETWORK']) {
    assert.throws(() => renderRuntime({ ...fixtureEnv, [name]: '' }), new RegExp(name));
  }
  assert.throws(() => renderRuntime({ ...fixtureEnv, DB_NAME: 'agrozanjir_db' }), /verified/);
  assert.throws(() => renderRuntime({ ...fixtureEnv, DB_USER: 'postgres' }), /verified/);
  const files = renderRuntime({ ...fixtureEnv, DB_HOST: 'shared-db', DB_PORT: '5544', DB_NETWORK: 'shared_database' });
  assert.ok(files['backend.env'].includes('@shared-db:5544/yoshlar_kapitali_db'));
  assert.equal(files['compose.env'], 'DB_NETWORK=shared_database\n');
});
