# YouthCapital on the dedicated Docker server

YouthCapital uses the operator-owned PostgreSQL container; it never creates a PostgreSQL service or volume. Redis remains a private, nonpersistent cache with `noeviction`. The existing shared edge Caddy serves the same API, admin, static and public-media routes. Private media is never mounted into Caddy.

Server inspection on 2026-10-26 confirmed:

| Resource | Verified value |
| --- | --- |
| SSH | `deploy@65.108.142.153`, port `22` |
| Project root / Compose project | `/opt/youthcapital` / `youthcapital` (both unused on the new host) |
| PostgreSQL container / network | `infrastructure-postgres-postgres-1` / `infrastructure_database` |
| Database / owner role | `yoshlar_kapitali_db` / `yoshlar_kapitali_user` |
| Role privileges | LOGIN; no SUPERUSER, CREATEDB or CREATEROLE; database CONNECT/CREATE/TEMP and public-schema USAGE/CREATE available |
| Destination data | Zero application tables; existing production data must be exported from the old origin |
| Internal DB address | `postgres:5432` |
| Public edge | `agrozanjir-caddy-1` already owns TCP 80/443 and UDP 443 |
| Project readiness ports | Host loopback 8000/8080 currently free |
| Domain | `yoshlarkapitali.uz` responds through Cloudflare; new origin does not yet have its certificate |

No repository `AGENTS.md` was present in this workspace. All three repositories were clean before this migration. AgroZanjir infrastructure was read as a reference; its working tree and production configuration were not edited.

## GitHub settings

Configure **Youth-Capital/infra → Settings → Environments → prod**. Application repositories keep their existing `prod` environments, GitHub App configuration, private GHCR publishing and release contracts. Runtime settings belong only in infra/prod.

| Type | Name | Required value |
| --- | --- | --- |
| Secret | `DB_USER` | `yoshlar_kapitali_user` |
| Secret | `POSTGRES_PASSWORD` | The already provisioned application role password; preserve this established secret name. Replace any old project's password with the correct new role password. |
| Variable | `DB_HOST` | `postgres` |
| Variable | `DB_PORT` | `5432` |
| Variable | `DB_NAME` | `yoshlar_kapitali_db` |
| Variable | `DB_NETWORK` | `infrastructure_database` |
| Secret | `VPS_HOST` | `65.108.142.153` |
| Variable | `VPS_USERNAME`, `VPS_PORT` | `deploy`, `22` |
| Secret | `VPS_SSH_KEY` | Authorized private deploy key, supplied through a secure entry mechanism |
| Secret | `VPS_KNOWN_HOSTS` | Verified host-key entry for this exact server |
| Variable | `DOMAIN` | `yoshlarkapitali.uz` |
| Variable | `ACME_EMAIL` | Existing certificate contact email |

Keep existing secrets `DJANGO_SECRET_KEY` (50+ random characters), `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, and optional integration secrets. Preserve the Django key during migration so signed data remains valid. Keep existing SMTP variables (`EMAIL_HOST`, `EMAIL_PORT`, `DEFAULT_FROM_EMAIL`), Gunicorn settings and optional provider settings. `POSTGRES_DB` and `POSTGRES_USER` are no longer deployment variables. No PostgreSQL administrator password is required, rendered, forwarded or used by these application workflows.

The database/role names are required and checked against the inspected project identity; there are no guessed fallback names. The password must be the existing app role's password; the established renderer requires at least 24 characters. Changing GitHub settings does not rotate a database password. Do not change shared PostgreSQL credentials or create another database/user.

GitHub CLI returned HTTP 401 during preparation, so settings have **not** been written or inspected through that connection. Authenticate securely before applying them; never paste passwords into chat or command-line arguments.

All three infra workflows (server-bootstrap, deploy-backend and deploy-frontend) forward these settings. Runtime files are mode 0600, copied over pinned SSH, and never sourced as shell scripts. Host/network interpolation lives in `runtime/compose.env`; credentials remain in raw `runtime/backend.env`. `DATABASE_URL` is also rendered for compatibility with previously published backend images. New backend settings read explicit `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_USER` first, and preserve legacy URL/POSTGRES_* support when explicit settings are absent.

## Architecture and commands

The base Compose file defines only Redis. The backend joins its private Redis network, external database network, and `youthcapital_edge`. The frontend joins its own network and `youthcapital_edge`, with no database/Redis access. Only the existing Caddy is added to `youthcapital_edge`. Unique service names `youthcapital-backend` and `youthcapital-frontend` prevent alias collisions with AgroZanjir's `backend` and `frontend`. The edge network is project-owned; the shared database network is external and must exist.

`lib.sh` retains the operator's `backend`/`frontend` argument names and translates service arguments to unique Compose names. It always uses `-p youthcapital` and `--env-file runtime/compose.env`. Avoid naked Compose commands: use the exact base/app files and both environment files when necessary. Never use `down`, `--remove-orphans`, volume removal, or global Docker prune for migration or deployment. Existing old database volumes remain untouched.

`server-bootstrap` now prepares project storage, runtime, include files and project-only maintenance units on an already provisioned host. It does not install packages, alter APT/Docker/PostgreSQL, change firewall/network/SSH/accounts, start containers, or reload Caddy. It refuses a conflicting project directory or occupied probe ports. It installs and enables project timers without starting them; start them explicitly after cutover. Existing timers are not stopped or restarted.

Routine immutable image pushes replace only the selected application after checking Redis. A manual infra deploy with `apply_shared=true` installs runtime/config, preserves sibling release files and reapplies initialized applications. These operations may restart the backend, whose existing entrypoint runs migrations automatically. **Approval is therefore required before deployment, not just before an explicit migrate command.** Bootstrap no longer runs application entrypoints. Shared Caddy updates always require a separate, approved validation/reload.

Application CI still scans, publishes private immutable images and updates only its own `apps/<app>/image.env`. First publication can use `publish_only=true`; grant infra Read under each package's Manage Actions access. Keep `INFRA_REPO=Youth-Capital/infra`, `INFRA_APP_ID` and `INFRA_APP_PRIVATE_KEY` only in application prod environments as before. Restrict prod deployments to main and use environment reviewers to prevent accidental rollout during migration.

## Shared edge integration

See [edge/README.md](edge/README.md). Caddy cannot be installed or started as another host service: 80/443 are already owned. The reviewable edge Caddy candidate and patch preserve the existing AgroZanjir site and add a YouthCapital include plus existing YouthCapital log redaction/Cloudflare trust settings. A Compose override adds only the project media mount, include directory and project edge network to the existing Caddy.

The include uses a **literal** YouthCapital hostname/contact, rendered from validated inputs; the edge's existing `DOMAIN=website-project.uz` remains unchanged. It uses unique upstreams and serves only `/opt/youthcapital/data/media` at `/srv/youthcapital/media`. Private files stay in `/opt/youthcapital/data/private-media` (0700); upload scratch stays under its `.tmp`. App storage uses numeric UID/GID 10001. The backend keeps loopback 8000 and frontend loopback 8080 for host readiness probes.

[SETUP.md](SETUP.md) contains the approval gates and exact rollout order, including data transfer and certificate issuance. [EMAIL.md](EMAIL.md) retains the existing SMTP runbook.

## Backups and restores

`scripts/backup.sh` creates `/opt/youthcapital/backups/<UTC timestamp>/` containing a custom-format dump of **only** `yoshlar_kapitali_db`, public and private media (excluding `.tmp`), and a project/database manifest with SHA-256 checksums. A shared lock serializes project deployments and maintenance. PostgreSQL tools run inside the existing shared container via password-authenticated TCP as **yoshlar_kapitali_user**, never postgres. The password travels in process environment, not argv or logs. No cluster/global-role dump is made.

Daily local backups are scheduled for 02:10 Asia/Tashkent; token cleanup for 03:10. Local backups are not offsite disaster recovery. Copy completed snapshots through an approved encrypted offsite process; no retention pruning, volume deletion or other project's backup jobs are installed. Failed snapshots remain clearly marked `.incomplete-*`; investigate before manual cleanup.

For a consistent database/media cutover, stop application writes before the final snapshot; a live scheduled backup is database-consistent but cannot guarantee a simultaneous media/database point in time. Keep old source backups and service state for rollback.

```sh
sudo /opt/youthcapital/scripts/backup.sh
# Restore is destructive within this project's DB and requires explicit approval.
# Stop YouthCapital writes first and take a fresh pre-restore backup.
sudo /opt/youthcapital/scripts/restore.sh /opt/youthcapital/backups/<snapshot> --confirm-project-restore
```

Restore validates project identity, all checksums and media archive paths before database writes. It restores only the fixed application database in one transaction, without changing owners, ACLs, roles, or any database creation/drop. Unsafe links/devices/traversal are rejected. Media is overlaid and ownership restored to 10001; files absent from the snapshot are intentionally retained. For an exact media rollback, use empty, separately prepared project media directories and keep the previous directories for recovery. Never restore a cluster dump into the shared container. Do not restore an untrusted SQL/archive file.

## Validation

Infra CI checks runtime/release guards, secret transport, workflow setting forwarding, independent Compose models, shell syntax/ShellCheck, provisioned-host bootstrap isolation, project backup/restore scope, Caddy route/error-log redaction and Cloudflare forged-header rejection. Gitleaks, Semgrep and Trivy scan current source/config using pinned images. Backend CI retains its existing full suite and source/image scans; dedicated tests verify explicit DB settings, legacy compatibility and rejection of partial explicit configuration.

```sh
node --test tests/runtime.test.mjs tests/workflows.test.mjs tests/compose.test.mjs tests/edge.test.mjs tests/caddy.test.mjs tests/proxy.test.mjs tests/bootstrap.test.mjs
bash tests/deploy.test.sh
python3 tests/project_backup_test.py
shellcheck -x scripts/*.sh tests/*.sh
```

Docker tests run disposable **local** validation containers, never production services. Do not print expanded production `docker compose config`; use `config --quiet`. Actual password authentication, restore of old data, migrations, edge reload, ACME issuance and public cutover remain approval-gated rollout checks.

See [VERIFICATION.md](VERIFICATION.md) for executed checks and the dated security findings. Backend main has since received dependency updates; the combined revision must pass the release security gate before deployment. Migration validation does not waive that gate.
