import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../scripts/bootstrap.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const check = source.match(/python3 - "\$domain" <<'PY'\n([\s\S]*?)\nPY/)[1];
const image = 'python:3.14.7-alpine@sha256:9e9fde4d32eedce0b661d9ab91e826b62dddf28e928c230ec55f1866cac66b01';

for (const [name, answers, succeeds] of [
  ['Cloudflare proxied A and AAAA', { A: '104.21.30.67\n172.67.172.55', AAAA: '2606:4700:3031::6815:1e43' }, true],
  ['direct A and AAAA', { A: '203.0.113.10', AAAA: '2001:db8::10' }, true],
  ['CNAME followed by address', { A: 'origin.example.test.\n203.0.113.10', AAAA: '2001:db8::10' }, true],
  ['missing A', { A: '', AAAA: '2001:db8::10' }, false],
  ['missing AAAA', { A: '203.0.113.10', AAAA: '' }, false],
]) {
  test(`bootstrap DNS validation: ${name}`, () => {
    // Execute the real bootstrap check with deterministic DNS responses.
    const program = `import json, subprocess, sys\nanswers=json.loads(sys.argv[1])\nsys.argv=['bootstrap','example.test']\nsubprocess.check_output=lambda args, **kwargs: answers[args[2]] if kwargs.get('text') else answers[args[2]].encode()\nexec(${JSON.stringify(check)})`;
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none', image, 'python', '-c', program, JSON.stringify(answers)], { encoding: 'utf8', timeout: 60_000 });
    if (succeeds) assert.equal(result.status, 0, result.stderr);
    else { assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /No (A|AAAA) addresses resolved/); }
  });
}
