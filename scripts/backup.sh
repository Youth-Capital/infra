#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 30m "$@"
yc_lock
python3 "$YC_ROOT/scripts/project_backup.py" backup "$YC_ROOT"
