#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 30m "$@"
yc_lock
[[ "${2:-}" == --confirm-project-restore ]] || { echo 'Stop project writes, take a backup, then use restore.sh snapshot-directory --confirm-project-restore.' >&2; exit 1; }
python3 "$YC_ROOT/scripts/project_backup.py" restore "$YC_ROOT" "${1:?snapshot directory required}"
