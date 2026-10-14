import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createBundle } from '../scripts/controller.mjs';

const directory = path.resolve(process.argv[2] || '.cache/validation');
const env = { DOMAIN: 'example.test', ACME_EMAIL: 'operations@example.test', DJANGO_SECRET_KEY: 'x'.repeat(60), POSTGRES_PASSWORD: 'test-only-'.repeat(4), EMAIL_HOST: 'smtp.example.test', EMAIL_HOST_USER: 'test-smtp-user', EMAIL_HOST_PASSWORD: 'test-smtp-password' };
createBundle(directory, { mode: 'bootstrap', shared: true, env });
for (const app of ['backend', 'frontend']) {
  writeFileSync(path.join(directory, 'apps', app, 'image.env'), `${app.toUpperCase()}_IMAGE=ghcr.io/youth-capital/${app}:${app}-${'a'.repeat(40)}-r1-123-a1@sha256:${'b'.repeat(64)}\n`);
}
