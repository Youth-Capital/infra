import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyRelease, writeRuntime } from './runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function remoteCommand({ mode, app, shared, remote, port, actor }) {
  if (!/^\/tmp\/youthcapital\.[a-zA-Z0-9]+$/.test(remote) || !/^[a-zA-Z0-9_-]+(?:\[bot\])?$/.test(actor)) throw new Error('Invalid transport parameters');
  if (!['bootstrap', 'deploy'].includes(mode) || (mode === 'deploy' && !['backend', 'frontend'].includes(app))) throw new Error('Invalid deployment target');
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid SSH port');
  const login = `printf '%s' "$registry_token" | sudo -n timeout --signal=TERM --kill-after=15s 60s docker --config "$registry_config" login ghcr.io -u '${actor}' --password-stdin; `;
  // A fresh VPS has no Docker yet and no initialized private app to pull.
  const registry = mode === 'bootstrap' ? `if command -v docker >/dev/null 2>&1; then ${login}fi; ` : login;
  const prepare = `set -eu; cd '${remote}'; trap 'rm -rf "${remote}"' EXIT; tar -xzf bundle.tar.gz; registry_config=$(mktemp -d); trap 'rm -rf "$registry_config" "${remote}"' EXIT; IFS= read -r registry_token; ${registry}unset registry_token; `;
  const operation = mode === 'bootstrap'
    ? `sudo -n env DOCKER_CONFIG="$registry_config" timeout --signal=TERM --kill-after=15s 25m bash '${remote}/scripts/bootstrap.sh' '${remote}' '${port}'`
    : `${shared ? `sudo -n env DOCKER_CONFIG="$registry_config" bash '${remote}/scripts/apply-shared.sh' '${remote}'; ` : ''}sudo -n env DOCKER_CONFIG="$registry_config" bash /opt/youthcapital/scripts/deploy.sh '${app}' '${remote}/apps/${app}/image.env'`;
  return `timeout --signal=TERM --kill-after=15s ${mode === 'bootstrap' ? '28m' : '12m'} bash -c ${shellQuote(prepare + operation)}`;
}

function run(binary, args, { input, capture = false, timeout = 660_000 } = {}) {
  const result = spawnSync(binary, args, {
    input, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'inherit', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    // Child output is sufficient for diagnosis; never stringify environment/input.
    if (capture && result.stderr) console.error(result.stderr.trim());
    throw new Error(`${binary} failed${result.error?.code === 'ETIMEDOUT' ? ' (timeout)' : ''}`);
  }
  return result.stdout?.trim() || '';
}

export async function latestRelease(app, env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('GITHUB_REPOSITORY is required');
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  const branch = env.INFRA_BRANCH || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/apps/${app}/image.env?ref=${encodeURIComponent(branch)}`;
  let lastStatus;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
        signal: AbortSignal.timeout(30_000),
      });
      lastStatus = response.status;
      if (!response.ok) {
        if (response.status < 500) break;
      } else {
        const file = await response.json();
        if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('Invalid GitHub release response');
        return Buffer.from(file.content, 'base64').toString('utf8');
      }
    } catch (error) {
      if (attempt === 2) throw new Error('Reading the desired release timed out or failed');
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Cannot verify latest desired release (HTTP ${lastStatus ?? 'unavailable'})`);
}

export function sshSettings(env, directory) {
  const host = env.VPS_HOST || '';
  const username = env.VPS_USERNAME || '';
  const port = env.VPS_PORT || '22';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:_-]*$/.test(host) || !/^[a-z_][a-z0-9_-]*$/.test(username)) throw new Error('Invalid VPS host/username');
  if (username === 'root') throw new Error('VPS_USERNAME must be a dedicated non-root account');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid VPS_PORT');
  if (!env.VPS_SSH_KEY || !env.VPS_KNOWN_HOSTS) throw new Error('VPS_SSH_KEY and verified VPS_KNOWN_HOSTS are required');
  const key = path.join(directory, 'ssh-key');
  const known = path.join(directory, 'known-hosts');
  writeFileSync(key, `${env.VPS_SSH_KEY.replaceAll('\r\n', '\n').trim()}\n`, { mode: 0o600 });
  writeFileSync(known, `${env.VPS_KNOWN_HOSTS.replaceAll('\r\n', '\n').trim()}\n`, { mode: 0o600 });
  chmodSync(key, 0o600);
  const options = ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'LogLevel=ERROR'];
  return { ssh: [...options, '-p', port, '-l', username, host], scp: [...options, '-P', port], destination: `${username}@${host.includes(':') ? `[${host}]` : host}`, port };
}

export function createBundle(directory, { mode, app, shared, env = process.env }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (shared || mode === 'bootstrap') {
    for (const filename of ['compose.yaml', 'Caddyfile']) copyFileSync(path.join(repositoryRoot, filename), path.join(directory, filename));
    mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    for (const filename of ['lib.sh', 'deploy.sh', 'apply-shared.sh', 'bootstrap.sh']) {
      copyFileSync(path.join(repositoryRoot, 'scripts', filename), path.join(directory, 'scripts', filename));
    }
    for (const name of ['backend', 'frontend']) {
      const target = path.join(directory, 'apps', name);
      mkdirSync(target, { recursive: true });
      copyFileSync(path.join(repositoryRoot, 'apps', name, 'compose.yaml'), path.join(target, 'compose.yaml'));
    }
    writeRuntime(path.join(directory, 'runtime'), env);
  }
  if (mode === 'deploy') {
    mkdirSync(path.join(directory, 'apps', app), { recursive: true });
    copyFileSync(path.join(repositoryRoot, 'apps', app, 'image.env'), path.join(directory, 'apps', app, 'image.env'));
  }
}

export async function main(args, env = process.env) {
  const [mode, app = '', expected = '', sharedFlag = 'false'] = args;
  if (!['bootstrap', 'deploy'].includes(mode)) throw new Error('Use controller.mjs bootstrap or deploy backend|frontend expected_image apply_shared');
  const shared = sharedFlag === 'true';
  if (mode === 'deploy') {
    if (!['backend', 'frontend'].includes(app)) throw new Error('Unknown application');
    const contents = readFileSync(path.join(repositoryRoot, 'apps', app, 'image.env'), 'utf8');
    verifyRelease(app, contents, expected, await latestRelease(app, env));
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'youthcapital-'));
  let remote;
  let settings;
  try {
    settings = sshSettings(env, directory);
    const bundle = path.join(directory, 'bundle');
    createBundle(bundle, { mode, app, shared, env });
    const archive = path.join(directory, 'bundle.tar.gz');
    run('tar', ['-C', bundle, '-czf', archive, '.'], { timeout: 30_000 });
    const candidate = run('ssh', [...settings.ssh, 'umask 077; mktemp -d /tmp/youthcapital.XXXXXXXX'], { capture: true, timeout: 30_000 });
    if (!/^\/tmp\/youthcapital\.[a-zA-Z0-9]+$/.test(candidate)) throw new Error('Invalid remote staging directory');
    remote = candidate;
    run('scp', [...settings.scp, archive, `${settings.destination}:${remote}/bundle.tar.gz`], { timeout: 60_000 });
    const actor = env.GITHUB_ACTOR || '';
    if (!/^[a-zA-Z0-9_-]+(?:\[bot\])?$/.test(actor) || !env.GITHUB_TOKEN) throw new Error('GitHub registry identity/token is required');
    if (mode === 'deploy') {
      verifyRelease(app, readFileSync(path.join(repositoryRoot, 'apps', app, 'image.env'), 'utf8'), expected, await latestRelease(app, env));
    }
    // The token travels only through encrypted stdin, never argv or a saved shell script.
    // Entire command is bounded, including registry authentication and shared updates.
    run('ssh', [...settings.ssh, remoteCommand({ mode, app, shared, remote, port: settings.port, actor })], {
      input: `${env.GITHUB_TOKEN}\n`, timeout: mode === 'bootstrap' ? 29 * 60_000 : 13 * 60_000,
    });
  } finally {
    if (remote && settings) {
      try { run('ssh', [...settings.ssh, `rm -rf -- ${shellQuote(remote)}`], { timeout: 15_000, capture: true }); } catch { /* Remote timeout cleanup also runs; a failed host may need /tmp cleanup later. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
