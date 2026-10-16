#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 25m "$@"
yc_lock
bundle="${1:?Usage: bootstrap.sh bundle-directory SSH-port}"
ssh_port="${2:-22}"
[[ "$ssh_port" =~ ^[0-9]+$ ]] && (( ssh_port >= 1 && ssh_port <= 65535 )) || exit 1
[[ "$EUID" == 0 ]] || { echo 'Bootstrap needs root or passwordless sudo.' >&2; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
[[ "$ID" == ubuntu ]] && [[ "$VERSION_ID" =~ ^(22\.04|24\.04|26\.04)$ ]] || {
  echo 'Use supported Ubuntu 22.04, 24.04 or 26.04 LTS.' >&2; exit 1;
}
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo 'This stack builds linux/amd64 images.' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y ca-certificates curl gnupg ufw dnsutils python3
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.sources
curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
  https://dl.cloudsmith.io/public/caddy/stable/gpg.key | \
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/caddy.gpg
printf 'deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
  > /etc/apt/sources.list.d/caddy.list
apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
systemctl enable --now docker caddy

# Preserve the actual SSH port before enabling host firewall rules.
sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw allow "$ssh_port/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' > /etc/sysctl.d/90-youthcapital-quic.conf
sysctl -p /etc/sysctl.d/90-youthcapital-quic.conf >/dev/null

# Hetzner configures a Primary IPv6 supplied at creation. Do not rewrite netplan.
if ! ip -6 address show scope global | grep -q 'inet6 ' || ! ip -6 route show default | grep -q default; then
  echo 'IPv6 address/default route missing. Assign the VPS Primary IPv6 and follow provider network configuration before bootstrap.' >&2
  exit 1
fi
domain="$(sed -n 's/^DOMAIN=//p' "$bundle/runtime/caddy.env")"
# Proxied DNS returns Cloudflare addresses; only require working A/AAAA DNS.
python3 - "$domain" <<'PY'
import ipaddress
import subprocess
import sys

for record_type in ('A', 'AAAA'):
    records = []
    for line in subprocess.check_output(['dig', '+short', record_type, sys.argv[1]], text=True, timeout=15).splitlines():
        try:
            records.append(ipaddress.ip_address(line))
        except ValueError:  # Ignore a CNAME label; verify its final addresses.
            pass
    if not records:
        sys.exit(f'No {record_type} addresses resolved for the configured DOMAIN. Check DNS records, nameservers and DNS propagation; Cloudflare proxying is supported.')
PY
bash "$bundle/scripts/apply-shared.sh" "$bundle"
# Check the origin certificate directly: Cloudflare's edge certificate alone
# cannot prove Caddy has a valid certificate for Full (strict). Keep SNI/Host.
for attempt in {1..18}; do
  if curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 10 \
      --resolve "$domain:443:127.0.0.1" "https://$domain/" -o /dev/null; then
    break
  fi
  if [[ "$attempt" == 18 ]]; then
    echo 'Caddy origin certificate is not ready. Check journalctl -u caddy, origin TCP 80/443, Cloudflare DNS origin address and ACME HTTP challenge access. Keep the proxy enabled; allow /.well-known/acme-challenge/* through redirects/WAF.' >&2
    exit 1
  fi
  sleep 5
done
curl -6 --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 10 \
  --resolve "$domain:443:[::1]" "https://$domain/" -o /dev/null || {
  echo 'Origin IPv6 HTTPS failed on loopback; check Caddy IPv6 listening.' >&2; exit 1;
}
curl -6 --silent --show-error --connect-timeout 5 --max-time 15 "https://$domain/" -o /dev/null || {
  echo 'Public IPv6 HTTPS failed; check Cloudflare edge certificate status, DNS and provider connectivity.' >&2; exit 1;
}
ss -lun '( sport = :443 )' | grep -q ':443' || { echo 'Caddy is not listening on UDP 443 for HTTP/3.' >&2; exit 1; }
echo 'Bootstrap complete. Publish/deploy each application independently.'
