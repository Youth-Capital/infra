#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 10m "$@"
yc_lock
bundle="${1:?Usage: apply-shared.sh bundle-directory}"

# Validate before replacing the live Caddy configuration.
domain="$(sed -n 's/^DOMAIN=//p' "$bundle/runtime/caddy.env")"
email="$(sed -n 's/^ACME_EMAIL=//p' "$bundle/runtime/caddy.env")"
DOMAIN="$domain" ACME_EMAIL="$email" caddy validate --config "$bundle/Caddyfile" --adapter caddyfile

install -d -m 0755 "$YC_ROOT" "$YC_ROOT/scripts" "$YC_ROOT/apps/backend" "$YC_ROOT/apps/frontend"
install -d -m 0700 "$YC_ROOT/runtime"
install -m 0644 "$bundle/compose.yaml" "$YC_ROOT/compose.yaml"
for app in backend frontend; do
  install -m 0644 "$bundle/apps/$app/compose.yaml" "$YC_ROOT/apps/$app/compose.yaml"
done
for script in lib.sh deploy.sh apply-shared.sh bootstrap.sh; do
  install -m 0755 "$bundle/scripts/$script" "$YC_ROOT/scripts/$script"
done
for runtime in postgres backend caddy; do
  install -m 0600 "$bundle/runtime/$runtime.env" "$YC_ROOT/runtime/$runtime.env"
done
install -d -m 0755 "$YC_ROOT/data"
install -d -m 0755 "$YC_ROOT/data/media"
install -d -m 0700 "$YC_ROOT/data/private-media" "$YC_ROOT/data/private-media/.tmp"
# Some Ubuntu install implementations require named host users for -o/-g.
# These are container IDs, so assign numeric ownership with chown instead.
chown 10001:10001 "$YC_ROOT/data/media" "$YC_ROOT/data/private-media" "$YC_ROOT/data/private-media/.tmp"

install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s/runtime/caddy.env\n' "$YC_ROOT" > /etc/systemd/system/caddy.service.d/youthcapital.conf
install -m 0644 "$bundle/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl reload-or-restart caddy
yc_compose shared config --quiet
yc_compose shared up -d --wait --wait-timeout 120 postgres redis

# Configuration applies never copy either release file from an older snapshot.
for app in backend frontend; do
  if [[ -f "$YC_ROOT/apps/$app/image.env" ]]; then
    yc_image "$app" "$YC_ROOT/apps/$app/image.env" >/dev/null
    bash "$YC_ROOT/scripts/deploy.sh" "$app"
  fi
done
echo 'Shared configuration applied; initialized applications are healthy.'
