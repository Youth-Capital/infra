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
# Both DNS families must point directly at an address on this machine.
python3 - "$domain" <<'PY'
import ipaddress
import json
import subprocess
import sys

host = {
    ipaddress.ip_address(address['local'])
    for interface in json.loads(subprocess.check_output(['ip', '-j', 'address', 'show'], timeout=10))
    for address in interface.get('addr_info', [])
}
for record_type in ('A', 'AAAA'):
    records = []
    for line in subprocess.check_output(['dig', '+short', record_type, sys.argv[1]], text=True, timeout=15).splitlines():
        try:
            records.append(ipaddress.ip_address(line))
        except ValueError:  # Ignore a CNAME label; verify its final addresses.
            pass
    if not records or any(address not in host for address in records):
        sys.exit(f'Domain {record_type} records must all point directly to this VPS before bootstrap.')
PY
bash "$bundle/scripts/apply-shared.sh" "$bundle"
for attempt in {1..6}; do
  if curl -6 --silent --show-error --connect-timeout 5 --max-time 10 "https://$domain/" -o /dev/null; then
    break
  fi
  if [[ "$attempt" == 6 ]]; then
    echo 'Public IPv6 HTTPS is not reachable; check provider firewall and DNS.' >&2
    exit 1
  fi
  sleep 5
done
ss -lun '( sport = :443 )' | grep -q ':443' || { echo 'Caddy is not listening on UDP 443 for HTTP/3.' >&2; exit 1; }
echo 'Bootstrap complete. Publish/deploy each application independently.'
