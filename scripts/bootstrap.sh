#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 10m "$@"
yc_lock
bundle="${1:?Usage: bootstrap.sh bundle-directory [SSH-port]}"
[[ "$EUID" == 0 ]] || { echo 'Bootstrap needs root or passwordless sudo.' >&2; exit 1; }
# Already provisioned shared host: never install packages, change Docker,
# PostgreSQL, APT, firewall, networking, accounts or SSH.
for tool in docker python3 flock curl ss systemctl; do
  command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }
done
docker info >/dev/null
docker compose version
bash "$bundle/scripts/apply-shared.sh" "$bundle" --prepare-only

# These units belong exclusively to YouthCapital. No service starts here.
cat > /etc/systemd/system/youthcapital-backup.service <<UNIT
[Unit]
Description=YouthCapital database and media backup
After=docker.service
[Service]
Type=oneshot
UMask=0077
ExecStart=$YC_ROOT/scripts/backup.sh
UNIT
cat > /etc/systemd/system/youthcapital-backup.timer <<'UNIT'
[Unit]
Description=Daily YouthCapital backup
[Timer]
OnCalendar=*-*-* 02:10:00 Asia/Tashkent
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/youthcapital-maintenance.service <<UNIT
[Unit]
Description=Expire YouthCapital refresh-token blacklist entries
After=docker.service
[Service]
Type=oneshot
ExecStart=$YC_ROOT/scripts/maintenance.sh
UNIT
cat > /etc/systemd/system/youthcapital-maintenance.timer <<'UNIT'
[Unit]
Description=Daily YouthCapital token maintenance
[Timer]
OnCalendar=*-*-* 03:10:00 Asia/Tashkent
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
# Enable without --now: the operator starts timers after cutover approval.
systemctl enable youthcapital-backup.timer youthcapital-maintenance.timer
echo 'Project storage, runtime, edge include and maintenance units prepared. No containers or proxy were started or reloaded.'
