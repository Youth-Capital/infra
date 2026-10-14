#!/usr/bin/env bash
# Shared by root-owned scripts installed under /opt/youthcapital/scripts.
set -euo pipefail

YC_ROOT="${YC_ROOT:-/opt/youthcapital}"
export COMPOSE_IGNORE_ORPHANS=true

yc_lock() {
  if [[ "${YC_LOCK_HELD:-}" != 1 ]]; then
    exec 9>/run/lock/youthcapital.lock
    flock -w 60 9 || { echo 'Another deployment holds the server lock.' >&2; exit 1; }
    export YC_LOCK_HELD=1
  fi
}

yc_bounded() {
  local duration="$1"
  shift
  if [[ "${YC_TIMEOUT_HELD:-}" != 1 ]]; then
    export YC_TIMEOUT_HELD=1
    exec timeout --signal=TERM --kill-after=15s "$duration" bash "$0" "$@"
  fi
}

yc_compose() {
  local app="$1"
  shift
  local command=(docker compose -p youthcapital -f "$YC_ROOT/compose.yaml")
  if [[ "$app" != shared ]]; then
    command+=(-f "$YC_ROOT/apps/$app/compose.yaml" --env-file "$YC_ROOT/apps/$app/image.env")
  fi
  "${command[@]}" "$@"
}

yc_image() {
  local app="$1" file="$2" key image
  case "$app" in backend) key=BACKEND_IMAGE ;; frontend) key=FRONTEND_IMAGE ;; *) return 1 ;; esac
  image="$(sed -n "s/^${key}=//p" "$file")"
  [[ "$image" =~ ^ghcr\.io/youth-capital/$app:$app-[a-f0-9]{40}-r[1-9][0-9]*-[1-9][0-9]*-a[1-9][0-9]*@sha256:[a-f0-9]{64}$ ]] || {
    echo "Invalid or uninitialized $app image.env; an immutable GHCR tag and digest are required." >&2
    return 1
  }
  # Do not source image.env: it is data, even when supplied by another repo.
  [[ "$(grep -cvE '^[[:space:]]*(#.*)?$' "$file")" == 1 ]] || return 1
  printf '%s' "$image"
}
