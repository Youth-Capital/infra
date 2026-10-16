import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const caddy = 'caddy:2-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f';
const node = 'node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20';
const curl = 'curlimages/curl:latest@sha256:58adaa4e8dca9c988bae2aba4ab3434a0bb2da16bbe3f92dec39ec7785166777';
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('Cloudflare visitor IP is trusted only from an approved proxy peer', async () => {
  const name = `infra-proxy-test-${Date.now()}`;
  const directory = mkdtempSync(path.join(tmpdir(), name));
  const octet = Math.floor(Math.random() * 200) + 20;
  const prefix = `198.19.${octet}`;
  const source = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8');
  assert.ok(source.includes('client_ip_headers CF-Connecting-IP'));
  assert.ok(source.includes('173.245.48.0/20'));
  assert.ok(source.includes('2c0f:f248::/32'));
  assert.equal(source.includes('trusted_proxies static private_ranges'), false);
  // Substitute a single synthetic proxy peer only in this disposable fixture.
  writeFileSync(path.join(directory, 'Caddyfile'), source
    .replace(/trusted_proxies static[^\n]+/, `trusted_proxies static ${prefix}.3/32`)
    .replace('127.0.0.1:8000', `${name}-upstream:8000`));
  const containers = [];
  let network = false;
  try {
    docker(['network', 'create', '--subnet', `${prefix}.0/24`, name]); network = true;
    docker(['run', '-d', '--name', `${name}-upstream`, '--network', name, node, 'node', '-e',
      'require("node:http").createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify(req.headers));}).listen(8000,"0.0.0.0")']);
    containers.push(`${name}-upstream`);
    docker(['run', '-d', '--name', `${name}-edge`, '--network', name,
      '-e', 'DOMAIN=http://localhost:8080', '-e', 'ACME_EMAIL=ops@example.test',
      '-v', `${path.join(directory, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, caddy]);
    containers.push(`${name}-edge`);
    const probe = (peer, headers) => JSON.parse(docker(['run', '--rm', '--network', name, '--ip', peer,
      curl, '-sS', '--fail', '--retry', '5', '--retry-all-errors', '--retry-delay', '1', '--max-time', '10',
      '-H', 'Host: localhost:8080', ...headers.flatMap(header => ['-H', header]), `http://${name}-edge:8080/api/probe`]));
    const forged = ['CF-Connecting-IP: 203.0.113.23', 'X-Forwarded-For: 1.1.1.1', 'X-Forwarded-Proto: https'];
    const proxied = probe(`${prefix}.3`, forged);
    assert.equal(proxied['x-forwarded-for'], '203.0.113.23');
    assert.equal(proxied['x-forwarded-proto'], 'http');
    assert.equal(proxied.host, 'localhost:8080');
    const direct = probe(`${prefix}.4`, forged);
    assert.equal(direct['x-forwarded-for'], `${prefix}.4`);
    assert.equal(direct['x-forwarded-proto'], 'http');
    const missing = probe(`${prefix}.3`, []);
    assert.equal(missing['x-forwarded-for'], `${prefix}.3`);
  } finally {
    for (const container of containers.reverse()) docker(['rm', '-f', container]);
    if (network) docker(['network', 'rm', name]);
    rmSync(directory, { recursive: true, force: true });
  }
});
