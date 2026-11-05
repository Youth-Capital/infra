#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
yc_bounded 5m "$@"
yc_lock
[[ -f "$YC_ROOT/apps/backend/image.env" ]] || exit 0
yc_compose backend exec -T backend python manage.py flushexpiredtokens
