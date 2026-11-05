#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
domain="$(sed -n 's/^DOMAIN=//p' "$YC_ROOT/runtime/caddy.env")"
[[ "$domain" =~ ^[a-z0-9.-]+$ ]] || exit 1
# No -k: the public edge certificate cannot prove Full (strict) origin TLS.
curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 20 \
  --resolve "$domain:443:127.0.0.1" "https://$domain/" -o /dev/null
curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 20 \
  --resolve "$domain:443:[::1]" "https://$domain/" -o /dev/null
curl --fail --silent --show-error --connect-timeout 5 --max-time 20 "https://$domain/" -o /dev/null
echo 'Origin IPv4/IPv6 certificates and public HTTPS verified.'
