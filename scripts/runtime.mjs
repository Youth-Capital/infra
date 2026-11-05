import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function scalar(name, value) {
  const text = String(value ?? '');
  if (/[\r\n\0]/.test(text)) throw new Error(`${name} must be a single-line value`);
  return text;
}

function required(env, name) {
  const value = scalar(name, env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(env, name, fallback, min, max) {
  const value = scalar(name, env[name] || fallback);
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export function envFile(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${scalar(key, value)}\n`).join('');
}

export function renderRuntime(env) {
  const domain = required(env, 'DOMAIN');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error('DOMAIN must be a lowercase fully qualified hostname');
  }
  const acmeEmail = required(env, 'ACME_EMAIL');
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(acmeEmail)) {
    throw new Error('ACME_EMAIL must be an email address');
  }
  const secret = required(env, 'DJANGO_SECRET_KEY');
  if (secret.length < 50) throw new Error('DJANGO_SECRET_KEY needs at least 50 random characters');
  const password = required(env, 'POSTGRES_PASSWORD');
  if (password.length < 24) throw new Error('POSTGRES_PASSWORD needs at least 24 random characters');
  const db = required(env, 'DB_NAME');
  const user = required(env, 'DB_USER');
  for (const value of [db, user]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Postgres database/user names must be lowercase SQL identifiers');
  }
  // This deployment is deliberately restricted to the operator-provisioned DB.
  if (db !== 'yoshlar_kapitali_db' || user !== 'yoshlar_kapitali_user') {
    throw new Error('DB_NAME/DB_USER must match the verified YouthCapital database and role');
  }
  const host = required(env, 'DB_HOST');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw new Error('Invalid DB_HOST');
  const port = integer(env, 'DB_PORT', '5432', 1, 65535);
  const network = required(env, 'DB_NETWORK');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(network)) throw new Error('Invalid DB_NETWORK');
  const origin = `https://${domain}`;
  const backend = {
    DJANGO_SETTINGS_MODULE: 'config.settings.prod',
    DJANGO_DEBUG: 'False',
    DJANGO_SECRET_KEY: secret,
    DJANGO_ALLOWED_HOSTS: `${domain},localhost`,
    DB_HOST: host, DB_PORT: port, DB_NAME: db, DB_USER: user,
    POSTGRES_PASSWORD: password,
    // Retain compatibility with published images whose entrypoint needs a URL.
    DATABASE_URL: `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(db)}`,
    DATABASE_SSL_REQUIRE: 'False',
    REDIS_URL: 'redis://redis:6379/0',
    CELERY_BROKER_URL: '',
    FRONTEND_URL: origin,
    CORS_ALLOWED_ORIGINS: origin,
    CSRF_TRUSTED_ORIGINS: origin,
    TRUSTED_PROXY_COUNT: '1',
    AUTH_COOKIE_SECURE: 'True',
    AUTH_COOKIE_SAMESITE: 'Lax',
    AUTH_COOKIE_DOMAIN: '',
    BILLING_MANUAL_AUTO_CONFIRM: 'False',
    GUNICORN_WORKERS: integer(env, 'GUNICORN_WORKERS', '2', 1, 16),
    GUNICORN_TIMEOUT: integer(env, 'GUNICORN_TIMEOUT', '300', 30, 600),
    EMAIL_HOST: required(env, 'EMAIL_HOST'),
    EMAIL_PORT: integer(env, 'EMAIL_PORT', '587', 1, 65535),
    EMAIL_HOST_USER: required(env, 'EMAIL_HOST_USER'),
    EMAIL_HOST_PASSWORD: required(env, 'EMAIL_HOST_PASSWORD'),
    DEFAULT_FROM_EMAIL: env.DEFAULT_FROM_EMAIL || `noreply@${domain}`,
    AI_DEFAULT_PROVIDER: env.AI_DEFAULT_PROVIDER || 'RULE_BASED',
    AI_LOG_PROMPT_CONTENT: 'False',
  };
  for (const name of ['SENTRY_DSN', 'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    backend[name] = env[name] || '';
  }
  return {
    'compose.env': envFile({ DB_NETWORK: network }),
    'backend.env': envFile(backend),
    'caddy.env': envFile({ DOMAIN: domain, ACME_EMAIL: acmeEmail }),
  };
}

export function writeRuntime(directory, env) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, contents] of Object.entries(renderRuntime(env))) {
    writeFileSync(path.join(directory, name), contents, { mode: 0o600 });
  }
}

export function parseImage(app, contents) {
  if (!['backend', 'frontend'].includes(app)) throw new Error('Unknown application');
  const lines = contents.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const prefix = `${app.toUpperCase()}_IMAGE=`;
  if (lines.length !== 1 || !lines[0].startsWith(prefix)) throw new Error(`Invalid or uninitialized ${app} image.env`);
  const image = lines[0].slice(prefix.length);
  const pattern = new RegExp(`^ghcr\\.io/youth-capital/${app}:${app}-[a-f0-9]{40}-r[1-9][0-9]*-[1-9][0-9]*-a[1-9][0-9]*@sha256:[a-f0-9]{64}$`);
  if (!pattern.test(image)) throw new Error(`${app} image must include its immutable release tag and digest`);
  return image;
}

export function verifyRelease(app, checkedOutContents, expectedImage, latestContents) {
  const image = parseImage(app, checkedOutContents);
  if (expectedImage && image !== expectedImage) throw new Error('Requested image does not match this workflow commit');
  if (parseImage(app, latestContents) !== image) throw new Error('Release superseded on main; refusing to deploy an older image');
  return image;
}
