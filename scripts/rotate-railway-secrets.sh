#!/usr/bin/env bash
# Sets the rotated secrets from .env.railway on the almaher-server Railway
# service in one change (one redeploy). Values are never printed.
#
#   ./scripts/rotate-railway-secrets.sh
#
# Needs `railway login` and `railway link` in this folder. DATABASE_URL is
# left alone: it references the Postgres service and follows its password.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env.railway ] || { echo ".env.railway not found" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. ./.env.railway
set +a

missing=()
for name in AUTH_SECRET ADMIN_KEY LIVEKIT_API_KEY LIVEKIT_API_SECRET; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "Fill these in .env.railway first: ${missing[*]}" >&2
  exit 1
fi

args=(
  --set "AUTH_SECRET=$AUTH_SECRET"
  --set "ADMIN_KEY=$ADMIN_KEY"
  --set "LIVEKIT_API_KEY=$LIVEKIT_API_KEY"
  --set "LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET"
)
# Only when a new LiveKit project URL was given.
[ -n "${LIVEKIT_URL:-}" ] && args+=(--set "LIVEKIT_URL=$LIVEKIT_URL")

railway variables --service almaher-server "${args[@]}" >/dev/null
echo "Set $(( ${#args[@]} / 2 )) variable(s) on almaher-server; Railway is redeploying it."
