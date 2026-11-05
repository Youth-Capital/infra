#!/usr/bin/env bash
set -euo pipefail
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export YC_ROOT="$scratch/root" YC_LOCK_HELD=1 YC_TIMEOUT_HELD=1 TEST_LOG="$scratch/commands"
mkdir -p "$scratch/bin"
node tests/fixtures.mjs "$scratch/bundle"
# An installed image manifest must not make bootstrap start an app.
mkdir -p "$YC_ROOT/apps/backend"
cp "$scratch/bundle/apps/backend/image.env" "$YC_ROOT/apps/backend/image.env"
for tool in docker ss systemctl; do
  cat > "$scratch/bin/$tool" <<'MOCK'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "$TEST_LOG"
case "${0##*/}" in
  docker)
    if [[ "$*" == *' up '* || "$*" == *' restart '* || "$*" == *' run '* ]]; then exit 90; fi
    ;;
  ss) ;;
  systemctl)
    if [[ "$*" == *'--now'* || "$*" == *restart* || "$*" == *reload-or-restart* ]]; then exit 91; fi
    ;;
esac
MOCK
  chmod +x "$scratch/bin/$tool"
done
# Catch all prohibited host mutations if introduced in a future change.
for tool in apt-get apt ufw sysctl usermod groupadd curl caddy; do
  printf '#!/bin/bash\nexit 92\n' > "$scratch/bin/$tool"
  chmod +x "$scratch/bin/$tool"
done
# Prerequisite check only; Python is not needed for file preparation.
printf '#!/bin/bash\nexit 0\n' > "$scratch/bin/python3"
chmod +x "$scratch/bin/python3"
export PATH="$scratch/bin:$PATH"
bash scripts/bootstrap.sh "$scratch/bundle" 22
test -f "$YC_ROOT/runtime/backend.env"
test -f "$YC_ROOT/runtime/compose.env"
test -f "$YC_ROOT/edge/site.caddy"
test -f "$YC_ROOT/scripts/project_backup.py"
test -f /etc/systemd/system/youthcapital-backup.timer
test -f /etc/systemd/system/youthcapital-maintenance.timer
test "$(stat -c %a "$YC_ROOT/runtime/backend.env")" == 600
test "$(stat -c %u "$YC_ROOT/data/media")" == 10001
test "$(stat -c %a "$YC_ROOT/data/private-media")" == 700
if grep -Eq 'docker .* (up|run|restart)|systemctl .*--now|docker .*prune|docker .*volume' "$TEST_LOG"; then exit 1; fi
if test -e /etc/caddy/Caddyfile; then exit 1; fi
# Source guards complement executing the real script with denied commands.
if grep -Eq 'apt-get|ufw |sysctl |usermod |groupadd |download.docker|/etc/ssh/' scripts/bootstrap.sh; then exit 1; fi
echo 'Provisioned-host bootstrap isolation passed.'
