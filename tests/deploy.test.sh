#!/usr/bin/env bash
set -euo pipefail
repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export YC_ROOT="$scratch/root with spaces"
export YC_LOCK_HELD=1 YC_TIMEOUT_HELD=1
export TEST_LOG="$scratch/docker.log" TEST_CURL_LOG="$scratch/curl.log" TEST_COMMAND_LOG="$scratch/commands.log"
mkdir -p "$scratch/bin" "$YC_ROOT/apps/backend" "$YC_ROOT/apps/frontend"
cat > "$scratch/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$TEST_LOG"
printf '%q ' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"
if [[ "${TEST_FAIL_SHARED:-}" == 1 && "$*" == *'postgres redis'* ]]; then exit 13; fi
if [[ "${TEST_FAIL_PULL:-}" == 1 && "$*" == *'pull backend'* ]]; then exit 12; fi
MOCK
cat > "$scratch/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$TEST_CURL_LOG"
printf '%s' "${TEST_HTTP_STATUS:-200}"
MOCK
chmod +x "$scratch/bin/docker" "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH"
printf 'BACKEND_IMAGE=ghcr.io/youth-capital/backend:backend-%040d-r1-123-a1@sha256:%064d\n' 0 0 > "$scratch/backend.env"
bash "$repository/scripts/deploy.sh" backend "$scratch/backend.env"
grep -q '^backend$' "$TEST_LOG"
if grep -q '^frontend$' "$TEST_LOG"; then exit 1; fi
grep -q 'up .*postgres redis' "$TEST_COMMAND_LOG"
grep -Fq "$YC_ROOT/compose.yaml" "$TEST_LOG"
grep -q '^--no-deps$' "$TEST_LOG"
if grep -q '^--remove-orphans$' "$TEST_LOG"; then exit 1; fi
grep -q '^X-Forwarded-Proto: https$' "$TEST_CURL_LOG"
test ! -f "$YC_ROOT/apps/frontend/image.env"

: > "$TEST_LOG"
# Deliberately test a literal command substitution rather than executing it.
# shellcheck disable=SC2016
printf 'BACKEND_IMAGE=$(touch %s)\n' "$scratch/injected" > "$scratch/malicious.env"
if bash "$repository/scripts/deploy.sh" backend "$scratch/malicious.env"; then
  echo 'Shell-injected manifest was accepted.' >&2; exit 1
fi
test ! -e "$scratch/injected"
test ! -s "$TEST_LOG"
if bash "$repository/scripts/deploy.sh" unknown; then exit 1; fi

: > "$TEST_COMMAND_LOG"
if TEST_FAIL_PULL=1 bash "$repository/scripts/deploy.sh" backend "$scratch/backend.env"; then
  echo 'Pull failure was reported as deployment success.' >&2; exit 1
fi
if grep -q 'up .* backend ' "$TEST_COMMAND_LOG"; then exit 1; fi

: > "$TEST_LOG"
: > "$TEST_COMMAND_LOG"
if TEST_FAIL_SHARED=1 bash "$repository/scripts/deploy.sh" backend "$scratch/backend.env"; then
  echo 'Unhealthy dependencies were reported as deployment success.' >&2; exit 1
fi
if grep -q '^pull$' "$TEST_LOG"; then exit 1; fi

printf 'FRONTEND_IMAGE=ghcr.io/youth-capital/frontend:frontend-%040d-r2-456-a1@sha256:%064d\n' 0 0 > "$scratch/frontend.env"
bash "$repository/scripts/deploy.sh" frontend "$scratch/frontend.env"
grep -q '/healthz$' "$TEST_CURL_LOG"

for response in 204 302; do
  if TEST_HTTP_STATUS="$response" bash "$repository/scripts/deploy.sh" frontend "$scratch/frontend.env"; then
    echo "HTTP $response was accepted as readiness." >&2; exit 1
  fi
done

# Exercise the real timeout wrapper on a short-lived fixture, not a ten-minute test.
cat > "$scratch/timeout.sh" <<'SCRIPT'
#!/usr/bin/env bash
source "$TEST_REPOSITORY/scripts/lib.sh"
unset YC_TIMEOUT_HELD
if [[ "${1:-}" == child ]]; then sleep 20; exit; fi
yc_bounded 1s child
SCRIPT
export TEST_REPOSITORY="$repository"
set +e
timeout 5s bash "$scratch/timeout.sh"
status=$?
set -e
[[ "$status" == 124 ]]
echo 'Deployment isolation, literal manifests and bounded execution passed.'
