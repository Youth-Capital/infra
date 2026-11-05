# Approved rollout order

This is the runbook for the prepared migration, not authorization to execute it. No push, deployment, migration, production restart, DNS change, credential rotation, or volume deletion was performed during preparation.

## 1. Finish prerequisites before approval

1. Review the backend/infra diffs and [edge integration](edge/README.md), including the shared-edge interruption described there. Obtain approval for pushes, data restore, migrations, deployments, the one-time edge recreation/reload and DNS cutover.
2. Obtain the old origin's SSH target/key. The current public site responds, while the new `yoshlar_kapitali_db` has zero application tables. A missing source-data export is a hard cutover blocker. Do not treat the empty destination as a new installation or seed it over existing production data.
3. Authenticate GitHub securely and configure the exact infra/prod settings in [README.md](README.md#github-settings). Enter the existing app role password, not a generated replacement or PostgreSQL administrator password. Verify required environment reviewers/branch protections before any application push can update an image manifest and automatically deploy.
4. Verify the new host key through a trusted channel and store `VPS_KNOWN_HOSTS`; the supplied key must be authorized for `deploy`. Preserve existing host SSH/sudo/firewall/network configuration.
5. In Cloudflare, record the current origin A/AAAA contents, confirm this hostname's mode is **Full (strict)** and proxying remains enabled. Public HTTPS alone cannot reveal the dashboard's encryption mode or origin-record contents. Confirm that no other application uses `yoshlarkapitali.uz` on the destination. The existing edge `DOMAIN=website-project.uz` is unrelated and must be preserved.
6. Check current Cloudflare IP ranges against the Caddyfile. Permit unauthenticated, uncached HTTP requests to `/.well-known/acme-challenge/*` all the way to Caddy on TCP 80. Exempt this path from Always Use HTTPS, redirect rules, Access, WAF challenges and rate limits that would redirect/block it. A Full (strict) HTTPS redirect before the first certificate can create a validation deadlock. Preserve strict TLS; do not switch to Flexible or disable certificate verification.

## 2. Publish and prepare, with production deployment held

The initial 2026-10-26 backend dependency scan reported 7 critical and 26 high findings. Backend main has since received dependency updates; revalidate the combined revision before release and do not bypass the existing security gate. See [VERIFICATION.md](VERIFICATION.md).

1. After push approval, push infra changes first (without touching either image manifest). Its source-only push runs checks. Keep prod deployments gated.
2. Push the backend settings/entrypoint change and publish a scanned immutable image **without deploying**. Use the existing `publish_only=true` workflow or hold the environment approval. Preserve private GHCR access; ensure infra has package Read. The frontend image can remain unchanged.
3. Verify all checks. Dispatch **server bootstrap** on infra main after approving that operation. This installs project files/runtime/permissions and project-only maintenance units, and enables their timers without starting them. It creates no PostgreSQL service and does not start Redis/backend/frontend or touch the existing Caddy. It does not migrate.
4. Confirm `/opt/youthcapital/runtime/backend.env` is mode 0600, public media is UID/GID 10001 and private media is 0700. Do not display runtime contents. Check that the shared PostgreSQL container and external network remain healthy. Validate database authentication as the app role with a read-only connection test before restoring; do not grant more privileges automatically.

## 3. Copy final production data while writes are stopped

1. On the old origin, inspect its repository/runtime and run a read-only connection identity query (`SELECT current_database(), current_user`). Confirm the actual source DB, role, PostgreSQL container and public/private media paths. Do not assume they match the destination names. Check database size, media size and available destination storage.
2. Arrange a maintenance window. Stop/disable writes only for YouthCapital on the old origin; do not stop the shared new PostgreSQL container or another application's services. Retain the old site/storage for rollback.
3. Export only the confirmed source database with `pg_dump --format=custom` (no cluster/role dump, no `--create`). Export only the project's public/private media, excluding `private-media/.tmp`. Use trusted local/container authentication; never print a connection URL/password or put it into argv. An example after setting **verified, non-secret** `SOURCE_POSTGRES`, `SOURCE_DB_USER`, `SOURCE_DB_NAME` is:

   ```sh
   umask 077
   sudo docker exec "$SOURCE_POSTGRES" pg_dump --username="$SOURCE_DB_USER" --dbname="$SOURCE_DB_NAME" --format=custom > database.dump
   # Run under the verified old project data directory.
   sudo tar --exclude=private-media/.tmp -czf media.tar.gz media private-media
   ```

4. Transfer these two files through SSH into a private migration snapshot directory under `/opt/youthcapital/backups/`. Record source identity/provenance separately. After verifying the export belongs to YouthCapital, run the following **inside that snapshot directory** to map its contents to the inspected destination database. Do not rename or restore an unrelated dump. Validate the archive and available storage before approval to restore.

   ```sh
   sudo python3 - <<'PY'
   import hashlib, json
   from pathlib import Path
   hashes = {}
   for name in ('database.dump', 'media.tar.gz'):
       with Path(name).open('rb') as stream:
           hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
   Path('manifest.json').write_text(json.dumps({
       'project': 'youthcapital', 'database': 'yoshlar_kapitali_db', 'files': hashes,
   }) + '\n')
   PY
   ```
5. Take a destination pre-restore backup using `sudo /opt/youthcapital/scripts/backup.sh`, even if the database is still empty. Then, after restore approval, run:

   ```sh
   sudo /opt/youthcapital/scripts/restore.sh /opt/youthcapital/backups/<migration-snapshot> --confirm-project-restore
   ```

   This connects as the app role, restores only `yoshlar_kapitali_db` transactionally without restoring roles/ACLs/owners, and restores both media trees. Keep the backend stopped until restore completes. Confirm expected table counts and representative public/private media against the source; never use a seed command as a substitute for transfer.

## 4. Deploy applications, then integrate the shared edge

1. Approve the backend deployment only after restore. Its existing entrypoint runs schema migrations before Gunicorn starts. Select the intended immutable image using the existing release guard; normal release workflows update the backend manifest, while manual infra deployment verifies it against latest main. Apply project configuration using `apply_shared=true` as needed. Deploy the unchanged frontend image through its own existing workflow. Do not dispatch another application release merely to rebuild unrelated frontend code.
2. Require backend loopback readiness on `127.0.0.1:8000/api/v1/health/ready/` with `Host: localhost` and `X-Forwarded-Proto: https`, and frontend `/healthz` on loopback 8080. Confirm Redis is healthy, only the backend joins `infrastructure_database`, and the expected project edge network exists. Check read-only data counts, login, representative assets and private-download authorization before public traffic.
3. Apply the reviewed persistent AgroZanjir edge integration as described in [edge/README.md](edge/README.md). Validate the **merged** Caddy/Compose models first and preserve the existing edge site's routes and certificate storage. One approved recreation of the Caddy container adds the directory/media mounts and project edge network. Use `--no-deps caddy` so no sibling application or Redis/PostgreSQL service is replaced. This briefly interrupts the shared edge; schedule it accordingly. Routine later site updates need validation and reload only.
4. Test the existing edge domain before/after and verify upstream DNS has no generic YouthCapital backend/frontend aliases. Never replace the existing edge environment's DOMAIN with YouthCapital's hostname.

## 5. Issue/verify origin TLS and cut over

Caddy's stock image supports HTTP-01. The YouthCapital site explicitly disables TLS-ALPN-01 because Cloudflare terminates that handshake. HTTP-01 needs TCP 80 and the challenge-path exceptions from step 1. No Cloudflare API token or custom DNS-provider image is required for this path.

A certificate cannot be issued on the new server through HTTP-01 while the domain's HTTP challenges still reach only the old origin. Choose the cutover window accordingly: update the hostname's proxied origin A record to `65.108.142.153`, update any origin AAAA to the verified new IPv6 (or remove the obsolete origin AAAA), and reload the validated edge configuration. Public Cloudflare AAAA answers are edge addresses and do not prove a correct origin AAAA. Allow Caddy to issue the certificate; monitor `docker logs agrozanjir-caddy-1 --since 10m` without sharing token-bearing logs. Expect a short TLS-issuance interruption until the new certificate is ready.

If a zero-gap TLS cutover is required, obtain a hostname-valid origin certificate via an approved DNS-01 or existing-certificate transfer procedure **before** changing the origin, and review the corresponding certificate mounts/site config. That alternative has not been executed or configured here. Do not claim HTTP-01 preissuance succeeded against the old origin.

Run on the new host after issuance:

```sh
sudo /opt/youthcapital/scripts/verify-tls.sh
```

It validates the public-CA certificate directly on origin IPv4/IPv6 loopback with the real SNI/Host and also checks public HTTPS. No `-k` is used. An HTTP error can coexist with a valid origin certificate, so then verify frontend and backend public routes separately, requiring expected HTTP status codes. Full (strict) requires an unexpired certificate covering this hostname and a trusted issuer. A Cloudflare edge certificate is insufficient evidence. Confirm the dashboard still reports Full (strict), and verify no 525/526 errors.

Finally check public login/session/CSRF, uploads, public and private media, mail and readiness. Verify the prior shared edge domain still works. Reopen YouthCapital writes only when data, application and TLS checks pass. Start its two new timers explicitly:

```sh
sudo systemctl start youthcapital-backup.timer youthcapital-maintenance.timer
sudo /opt/youthcapital/scripts/backup.sh
```

Copy a completed snapshot to approved offsite storage and perform a separately approved restore rehearsal before retiring the source host. There is no automatic local-retention deletion.

## Rollback

Keep the old database, media, images, proxy configuration and origin DNS values intact throughout the window. If checks fail before writes reopen, restore the prior DNS/edge configuration and resume the old application. The new destination can remain stopped for diagnosis; never remove its volumes or touch another project's DB. If new writes have already been accepted, freeze writes and reconcile/export them before reversing traffic; blindly switching origins can lose data. Restore a project snapshot only after a fresh backup and explicit restore approval. Never run global Docker cleanup or recreate shared PostgreSQL to recover this application.
