#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 10m "$@"
yc_lock
bundle="${1:?Usage: apply-shared.sh bundle-directory [--prepare-only]}"
prepare_only="${2:-}"
[[ -z "$prepare_only" || "$prepare_only" == --prepare-only ]] || exit 1

# Read data without sourcing it. The host owner provisions this network.
network="$(sed -n 's/^DB_NETWORK=//p' "$bundle/runtime/compose.env")"
[[ "$network" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 1
docker network inspect "$network" >/dev/null
docker inspect infrastructure-postgres-postgres-1 >/dev/null
# Never adopt containers from a different deployment root under this name.
for container in $(docker ps -aq --filter label=com.docker.compose.project=youthcapital); do
  directory="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")"
  [[ "$directory" == "$YC_ROOT" ]] || { echo 'Compose project youthcapital belongs to another directory.' >&2; exit 1; }
done
# Loopback probes retain established ports. Refuse unrelated port owners.
for mapping in backend:8000 frontend:8080; do
  app="${mapping%:*}" port="${mapping#*:}"
  if ss -H -lnt "sport = :$port" | grep -q .; then
    owner="$(docker ps -q --filter label=com.docker.compose.project=youthcapital --filter "label=com.docker.compose.service=youthcapital-$app")"
    [[ -n "$owner" ]] || { echo "Port $port is already occupied by another service." >&2; exit 1; }
  fi
done
docker compose --project-directory "$bundle" --env-file "$bundle/runtime/compose.env" -f "$bundle/compose.yaml" config --quiet

install -d -m 0755 "$YC_ROOT" "$YC_ROOT/scripts" "$YC_ROOT/apps/backend" "$YC_ROOT/apps/frontend" "$YC_ROOT/edge"
install -d -m 0700 "$YC_ROOT/runtime" "$YC_ROOT/backups"
install -m 0644 "$bundle/compose.yaml" "$YC_ROOT/compose.yaml"
install -m 0644 "$bundle/Caddyfile" "$YC_ROOT/Caddyfile"
for app in backend frontend; do
  install -m 0644 "$bundle/apps/$app/compose.yaml" "$YC_ROOT/apps/$app/compose.yaml"
done
for script in lib.sh deploy.sh apply-shared.sh bootstrap.sh backup.sh restore.sh maintenance.sh verify-tls.sh; do
  install -m 0755 "$bundle/scripts/$script" "$YC_ROOT/scripts/$script"
done
install -m 0755 "$bundle/scripts/project_backup.py" "$YC_ROOT/scripts/project_backup.py"
for runtime in compose backend caddy; do
  install -m 0600 "$bundle/runtime/$runtime.env" "$YC_ROOT/runtime/$runtime.env"
done
# A directory bind mount lets the shared proxy see updated include files.
# Applying project configuration never reloads or modifies the shared edge.
install -m 0644 "$bundle/edge/site.caddy" "$YC_ROOT/edge/site.caddy"
install -d -m 0755 "$YC_ROOT/data" "$YC_ROOT/data/media"
install -d -m 0700 "$YC_ROOT/data/private-media" "$YC_ROOT/data/private-media/.tmp"
chown 10001:10001 "$YC_ROOT/data/media" "$YC_ROOT/data/private-media" "$YC_ROOT/data/private-media/.tmp"

if [[ "$prepare_only" == --prepare-only ]]; then exit 0; fi
yc_compose shared config --quiet
yc_compose shared up -d --wait --wait-timeout 120 redis
# Configuration applies preserve both server release files.
for app in backend frontend; do
  if [[ -f "$YC_ROOT/apps/$app/image.env" ]]; then
    yc_image "$app" "$YC_ROOT/apps/$app/image.env" >/dev/null
    bash "$YC_ROOT/scripts/deploy.sh" "$app"
  fi
done
echo 'Project configuration applied. Reload the shared edge separately if its site include changed.'
