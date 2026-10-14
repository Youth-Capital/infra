# Youth Capital production

Three repositories, one Ubuntu VPS, one Compose project. Application repositories publish scanned images and change their own `apps/<app>/image.env` here. Only this repository has VPS access. Caddy runs as an Ubuntu systemd service and proxies the two application containers through IPv4 loopback; the public website supports IPv4, IPv6, HTTPS and HTTP/3.

```text
backend CI  -> GHCR -> apps/backend/image.env  -> deploy-backend -> backend container
frontend CI -> GHCR -> apps/frontend/image.env -> deploy-frontend -> frontend container
                                      infra/prod owns SSH + runtime secrets
```

## Files and routine operations

| File | Purpose |
| --- | --- |
| `compose.yaml` | Shared Postgres 18 and Redis; their ports are private. |
| `apps/<app>/compose.yaml` | One application definition, merged with the base. |
| `apps/<app>/image.env` | The application's readable immutable tag **and digest**, set by its release workflow. |
| `Caddyfile` | Same-origin routing, TLS, public media and HTTP/3. |
| `scripts/bootstrap.sh` | Install Docker/Compose/Caddy, prepare disk and firewall, verify DNS/IPv6. |
| `scripts/apply-shared.sh` | Apply config/runtime files and reapply already initialized apps. |
| `scripts/deploy.sh` | Start/check Postgres and Redis, pull and replace one application, then verify health. |
| `scripts/controller.mjs`, `runtime.mjs` | GitHub release guard, SSH transfer and private runtime-file rendering. |

The fixed VPS directory is `/opt/youthcapital`, and every Compose command uses `-p youthcapital`. The backend and frontend use separate networks; frontend cannot connect directly to Postgres or Redis. The backend retains outbound access for SMTP and optional providers. Redis uses `noeviction` because evicting cache keys could reset security counters.

Normal image pushes change only the selected application's server image file. They start/check Postgres and Redis using the installed configuration, then replace the selected app; the sibling app keeps running. They do not apply shared config or runtime variables. A manual `deploy-backend` or `deploy-frontend` dispatch defaults `apply_shared=true`: install current shared config/runtime, preserve both server release files, reapply initialized apps, then deploy the selected release. Changing GitHub environment variables alone does not deploy anything; use that manual operation.

An empty initial image file is intentional. Bootstrap starts only Postgres and Redis; it never loads or pulls an application placeholder. Each application deploy loads only `compose.yaml` plus its own fragment. Do not use `docker compose down`, `--remove-orphans`, or `down -v` for deployments. The omitted sibling is an intentional orphan and continues running.

## One-time GitHub configuration

Create a **`prod` environment in all three repositories**. Restrict deployment branches to `main`, protect `main`, and require reviews for workflow/script changes. The infra workflows also explicitly refuse to select a deployment job on another branch. Use GitHub-hosted runners; the VPS is not a runner. Private repository environment secrets require a GitHub plan that supports environments.

Create a GitHub App, install it on **the infra repository only**, and grant repository **Contents: read/write** and **Actions: read/write**. It needs no Workflows permission. Contents permits the application release jobs to update image files; Actions permits recovery dispatch and observing deployment results. If an infra ruleset requires pull requests, explicitly allow this App's automated image commits through that rule. The App's credential has repository-wide contents access; protect the application release workflows that can use it.

In each application repository's `prod` environment, add the App private key under `INFRA_APP_PRIVATE_KEY` and its ID under the variable `INFRA_APP_ID`. Set `INFRA_REPO=Youth-Capital/infra`; its release workflow targets `main` and builds `linux/amd64`. No VPS or Django/database runtime secrets belong in application repositories. Browser build variables are public; the production API URL is relative `/api/v1`.

In **infra/prod**, configure:

| Secrets | Meaning |
| --- | --- |
| `VPS_SSH_KEY` | The account's private SSH key, including its complete multiline contents. |
| `VPS_KNOWN_HOSTS` | Verified OpenSSH known-hosts line for this exact host and port. |
| `DJANGO_SECRET_KEY` | At least 50 random characters; generate a real secret, not a placeholder. |
| `POSTGRES_PASSWORD` | At least 24 random characters. |
| `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD` | Required SMTP authentication; checked before server changes. |
| `SENTRY_DSN`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional integrations; leave absent when unused. |

| Variables | Default / purpose |
| --- | --- |
| `VPS_HOST` | Required VPS public IPv4 address or hostname; a literal global IPv6 address is supported too. |
| `VPS_USERNAME` | `deploy`; your manually created automation account. |
| `DOMAIN` | Required, e.g. `domain-name.uz`; lowercase hostname without scheme/path. |
| `ACME_EMAIL` | Required certificate contact email. |
| `EMAIL_HOST` | Required SMTP hostname. |
| `VPS_PORT` | `22`; must match the server's actual SSH port. |
| `POSTGRES_DB`, `POSTGRES_USER` | `youthcapital`. Set before first database initialization. |
| `GUNICORN_WORKERS`, `GUNICORN_TIMEOUT` | `2`, `300` seconds; suitable starting values for 2 CPU / 4 GB. |
| `EMAIL_PORT`, `DEFAULT_FROM_EMAIL` | `587`, `noreply@<DOMAIN>`. |
| `AI_DEFAULT_PROVIDER` | `RULE_BASED`; optional external providers need their matching secret. |

Runtime secrets must be single-line values. Password punctuation, including `$`, `#`, quotes and backslashes, is preserved using Compose's raw `env_file` format. Files are generated in private temporary runner directories, transferred over SSH and installed under root-readable `/opt/youthcapital/runtime` with mode `0600`. They are never sourced as shell scripts or printed. Do not run `docker compose config` without `--quiet` on production: expanded configuration contains secrets.

GHCR images stay **private**. Each app uses its own `GITHUB_TOKEN` to publish and clean up its package. After its first publication, open each package's **Package settings → Manage Actions access**, add **Youth-Capital/infra** with **Read**, and verify the publishing repository has Admin. This package-setting step cannot be done before the package exists. Infra's job token then authenticates pulls through a temporary Docker configuration on the VPS, which is removed when the operation finishes. No persistent GHCR PAT is needed. A reboot uses already downloaded images and does not require registry credentials.

## Create the VPS account and verify SSH trust

Use a fresh Hetzner **x86/64** VPS with **Ubuntu 24.04 LTS** (22.04/26.04 LTS are also accepted), 2 CPU / 4 GB, and Primary IPv4 **and** IPv6 assigned at creation. Set the domain's A/AAAA records to that VPS. Permit inbound SSH on your actual port, TCP 80/443, UDP 443, and ICMP in the Hetzner firewall; allow normal outbound traffic. Bootstrap validates both DNS families against addresses assigned to the host and verifies IPv6 HTTPS plus a UDP 443 listener. It preserves provider/cloud-init networking rather than rewriting netplan.

Create your SSH key yourself on a trusted machine:

```sh
ssh-keygen -t ed25519 -f youthcapital-deploy -C youthcapital-production
```

Use a dedicated automation key without a passphrase; the private key is protected by GitHub's `prod` environment. Through your existing trusted admin session or Hetzner Console, create the account and paste **the public key only**:

```sh
sudo adduser --disabled-password --gecos '' deploy
sudo install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
sudo tee /home/deploy/.ssh/authorized_keys >/dev/null
# Paste: restrict <the entire youthcapital-deploy.pub line>, then Ctrl+D.
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 0600 /home/deploy/.ssh/authorized_keys
printf 'deploy ALL=(ALL) NOPASSWD: ALL\n' | sudo tee /etc/sudoers.d/youthcapital-deploy >/dev/null
sudo chmod 0440 /etc/sudoers.d/youthcapital-deploy
sudo visudo -cf /etc/sudoers.d/youthcapital-deploy
```

Limit this account to key authentication and noninteractive commands:

```sh
sudo tee /etc/ssh/sshd_config.d/60-youthcapital-deploy.conf >/dev/null <<'SSH'
Match User deploy
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
Match all
SSH
sudo sshd -t
sudo systemctl reload ssh
```

If you choose a different `VPS_USERNAME`, change the account/path and `Match User` consistently. The `restrict` public-key option also disables forwarding and PTY requests. SSH commands and SCP/SFTP transfers still work. Keep the existing trusted admin session open while checking `ssh -i youthcapital-deploy deploy@<VPS_HOST> 'sudo -n true'` from another terminal. Only after that succeeds, disable root SSH through an early global config file containing `PermitRootLogin no`, run `sshd -t`, and reload SSH. Workflows never log in as root; administrative catalogue/password operations can use the Hetzner Console or a separate trusted operator account.

This account can administer the host through passwordless sudo, which is needed for package installation, Caddy/firewall changes and Docker. It has root-equivalent deployment privileges. Application containers use unprivileged users; the Docker daemon itself uses the standard rootful Ubuntu installation.

From the **Hetzner Console**, read the server's public host key and fingerprint:

```sh
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Set `VPS_KNOWN_HOSTS` to `203.0.113.10 ssh-ed25519 <the verified key>`, replacing the example host with exactly `VPS_HOST`. For a custom port, use `[203.0.113.10]:2222 ssh-ed25519 <key>`; for IPv6/custom port use `[2001:db8::1]:2222`. A `ssh-keyscan` result is only a candidate until its fingerprint matches the trusted console. Workflows use `StrictHostKeyChecking=yes` and never silently accept a changed key. Verify an SSH login and `sudo -n true` before running bootstrap.

## First deployment, retries and changing servers

1. Push the reviewed infra implementation to `main` first, then push the application implementations; the workflows only become available after those pushes. Finish `prod` settings, SSH trust and A/AAAA records, then dispatch **server bootstrap** on `main`. This installs signed apt packages, opens required host firewall ports while preserving SSH, persists QUIC UDP buffer settings, installs Caddy, and starts Postgres/Redis. An initial push containing empty release files can trigger rejected app deploy runs; these make no VPS changes. Real application releases replace the empty pointers.
2. Dispatch each application's **CI and release** workflow on `main` with `publish_only=true` to create its private GHCR package without deployment. Grant infra package Read access, then dispatch the full release with `publish_only=false`. Later, a failed app deploy job can be rerun without rebuilding or making an empty infra commit.
3. A new app release changes its image file and triggers only that app's infra deployment. The app pipeline waits for the matching infra run's successful **Deploy application** step before final GHCR cleanup. All VPS workflows use one queued concurrency group; server scripts also use a bounded `flock`.
4. Dispatch **deploy-backend** or **deploy-frontend** with `apply_shared=true` when changing Compose/Caddy config or runtime settings. Keep `expected_image` empty for ordinary manual use. Application recovery dispatches supply an exact expected image and `apply_shared=false`.
5. From the Hetzner Console or a trusted operator session, create the admin account and load the three production catalogues manually. Run the following from `/opt/youthcapital`; do not run demonstration/test seeding in production:

   ```sh
   sudo docker compose -p youthcapital -f compose.yaml -f apps/backend/compose.yaml --env-file apps/backend/image.env exec backend python manage.py createsuperuser
   sudo docker compose -p youthcapital -f compose.yaml -f apps/backend/compose.yaml --env-file apps/backend/image.env exec backend python manage.py seed_taxonomy
   sudo docker compose -p youthcapital -f compose.yaml -f apps/backend/compose.yaml --env-file apps/backend/image.env exec backend python manage.py seed_plans
   sudo docker compose -p youthcapital -f compose.yaml -f apps/backend/compose.yaml --env-file apps/backend/image.env exec backend python manage.py seed_soft_skill_test
   ```

Superseded or mismatched releases fail before deployment. The event commit's image must match both an optional requested image and the latest image file on `main`. Retrying an old app run cannot roll production back over a newer release. Failed health checks stop the workflow and prevent normal cleanup. Deployment jobs and HTTP/SSH/health waits have finite timeouts; errors never become silent successful skips.

The backend migrates on container startup and serves Django admin static files already built into its image. Public media is on `/opt/youthcapital/data/media`; private files and large-upload scratch are under `/opt/youthcapital/data/private-media`, which Caddy never serves. Postgres persists in the `youthcapital_postgres_data` named volume, mounted at `/var/lib/postgresql` for version 18. Redis is a nonpersistent cache. Container replacement may briefly interrupt that application; there is no Kubernetes or blue/green layer.

Postgres initialization variables apply only to an empty data directory. Changing `POSTGRES_PASSWORD` in GitHub does **not** rotate the existing database password. First change the role password interactively using `psql`'s `\password youthcapital`, then update the GitHub secret and apply shared configuration. Database/user-name changes and PostgreSQL major upgrades need explicit database migration. A new VPS recreates infrastructure; moving existing database/media data remains a separate operator task. No backup system is installed by this repository.

To replace the server, create the account/key trust and DNS on the new VPS, update only infra/prod's VPS settings, run **server bootstrap**, then manually dispatch each app's infra deployment with `apply_shared=false` to pull its already published release. Move existing data before enabling traffic if this is a replacement of a populated server.

Normal release cleanup retains the new image and the previous published image. An older cleanup retry skips if a newer image has been published, even when a publish-only run left infra unchanged. The app repositories also provide manual registry maintenance for accumulated failed releases. GHCR container storage/bandwidth is currently free; GitHub documents advance notice before any pricing change. Retention does not guarantee capacity under a future quota that is already consumed by protected images.

## Check and inspect

```sh
node --test tests/runtime.test.mjs
bash tests/deploy.test.sh
node tests/fixtures.mjs
docker compose -p youthcapital -f .cache/validation/compose.yaml config --quiet
docker compose -p youthcapital -f .cache/validation/compose.yaml -f .cache/validation/apps/backend/compose.yaml --env-file .cache/validation/apps/backend/image.env config --quiet
```

The `infra checks` workflow validates each independent Compose model, Caddy config, signed-download/password-reset token redaction and the meaningful guard/quoting/deployment tests without production secrets. Caddy preserves routine route logs while removing signed-download `t`, password-reset `token` query values and Referer headers from access and upstream-error logs. On the server, use targeted `compose ps`/`logs` commands with the same base+app flags, and `sudo journalctl -u caddy`. With an HTTP/3-capable client, `curl --http3-only -I https://<DOMAIN>` verifies public QUIC; `curl -6 -I https://<DOMAIN>` verifies IPv6. Keep Postgres/backend/frontend ports inaccessible publicly.
