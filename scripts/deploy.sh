#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 10m "$@"
yc_lock

app="${1:?Usage: deploy.sh backend|frontend [incoming-image.env]}"
case "$app" in backend|frontend) ;; *) echo 'Unknown application.' >&2; exit 1 ;; esac
incoming="${2:-$YC_ROOT/apps/$app/image.env}"
yc_image "$app" "$incoming" >/dev/null
if [[ "$incoming" != "$YC_ROOT/apps/$app/image.env" ]]; then
  install -m 0644 "$incoming" "$YC_ROOT/apps/$app/image.env"
fi

# Recover stopped dependencies, then replace only this application.
yc_compose "$app" config --quiet
yc_compose "$app" up -d --wait --wait-timeout 120 postgres redis
yc_compose "$app" pull "$app"
yc_compose "$app" up -d --no-deps --wait --wait-timeout 120 "$app"

if [[ "$app" == backend ]]; then
  status="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' \
    -H 'Host: localhost' -H 'X-Forwarded-Proto: https' \
    http://127.0.0.1:8000/api/v1/health/ready/)"
else
  status="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:8080/healthz)"
fi
[[ "$status" == 200 ]] || { echo "$app readiness returned HTTP $status, expected 200." >&2; exit 1; }
echo "$app is healthy."
