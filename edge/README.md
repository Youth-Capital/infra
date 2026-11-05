# Existing shared edge integration

These files are prepared locally for review. No AgroZanjir checkout or production file has been edited. Applying them requires approval because the edge also serves another application.

`Caddyfile` is a candidate based on `/opt/agrozanjir/Caddyfile`, read from the server on 2026-10-26. Its original SHA-256 is `a986a4531c7139abfb3cdb92c7daccd1562d3351dc46fa0a672689f82a822cb8`. `Caddyfile.patch` shows the exact addition: preserve the existing site and readiness route, preserve the admin binding, add YouthCapital's global log redaction and Cloudflare trust settings, then import `/etc/caddy/youthcapital/site.caddy`. Recheck the source hash before applying; if it has drifted, merge the patch into the current configuration instead of replacing it.

`compose.override.yaml` adds only the read-only project include directory, read-only public media directory and external `youthcapital_edge` network to service `caddy`. It preserves `web`, all existing ports, certificate/config storage and the other site's media mount. The project backend/frontend use unique service keys so attaching the edge does not introduce generic `backend`/`frontend` DNS aliases that could hijack the other site.

The generated site include is installed by YouthCapital bootstrap at `/opt/youthcapital/edge/site.caddy`. It has a literal YouthCapital hostname and ACME contact, so the existing edge DOMAIN remains `website-project.uz`. Do not mount project private media or runtime secrets into the shared edge.

Before the one-time edge recreation, persist these additions in the AgroZanjir infrastructure repository's base Compose/Caddyfile and its deployment path (or make its `common.sh` Compose wrapper always load the override). An ad hoc override omitted by a later AgroZanjir deployment would remove the mounts/network. Keep that change in its own reviewed commit. Do not run AgroZanjir bootstrap or redeploy its backend/frontend for this integration.

After approved YouthCapital app deployment creates `youthcapital_edge`, stage the override as `/opt/agrozanjir/compose.youthcapital.yaml` and the candidate Caddyfile under a separate review path. The server currently has the three environment files used below; recheck their existence without displaying contents. The existing compose files must still be supplied. The command pattern is:

```sh
cd /opt/agrozanjir
sudo docker compose -p agrozanjir \
  --env-file runtime/compose.env --env-file apps/backend/image.env --env-file apps/frontend/image.env \
  -f compose.yaml -f apps/backend/compose.yaml -f apps/frontend/compose.yaml \
  -f compose.youthcapital.yaml config --quiet
```

Validate the candidate using the **currently running Caddy image ID**, with the same public settings and required include mount, in a disposable container with **no published ports**. Use `caddy validate`, not the normal Caddy entrypoint: validation does not start a listener or obtain certificates. Never use `caddy run` as a validation command on the production host. The prepared local validation test checks both the standalone YouthCapital template and this merged candidate.

Once approved and validated, back up the old edge Caddyfile, preserve its file inode when copying the candidate into the existing bind-mounted file, and use the same Compose flags plus `up -d --no-deps --wait --wait-timeout 120 caddy` to add the mounts/network. This briefly replaces only the shared edge container. Confirm the existing site's health immediately. Never add `--remove-orphans`, run `down`, or change its certificate volumes. Persist the identical override additions before future AgroZanjir deployments.

For later include changes, validate the merged live configuration first, then the approved reload is:

```sh
sudo docker exec agrozanjir-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo docker exec agrozanjir-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

For initial certificate issuance, follow [SETUP.md](../SETUP.md#5-issueverify-origin-tls-and-cut-over). The new origin currently fails TLS for YouthCapital; issuance and Cloudflare dashboard settings have not been verified by an actual cutover. Keep Full (strict), exempt HTTP-01 from forced HTTPS, and verify origin TLS directly before reopening writes.
